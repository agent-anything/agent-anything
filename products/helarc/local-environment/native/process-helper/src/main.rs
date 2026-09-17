mod protocol;
mod windows;
use std::{collections::BTreeMap, io::{self, Read}, sync::{Arc, atomic::{AtomicBool, Ordering}, mpsc::{self, SyncSender}}, thread, time::{Duration, Instant}};
use serde::Deserialize;
use serde_json::json;
use protocol::{Frame, metadata};

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum Control {
    #[serde(rename = "launch")]
    Launch { executable: String, args: Vec<String>, cwd: String, environment: BTreeMap<String, String>, host_pid: u32 },
    #[serde(rename = "terminate")]
    Terminate { request_id: u32 },
    #[serde(rename = "close")]
    Close,
}

fn main() {
    if let Err(error) = run() { eprintln!("process-helper: {error}"); std::process::exit(1); }
}
fn run() -> io::Result<()> {
    let token = protocol::token(&std::env::args().nth(1).ok_or_else(|| protocol::invalid("execution token required"))?)?;
    let (facts, facts_rx) = mpsc::sync_channel(16); let (output, output_rx) = mpsc::sync_channel(32);
    thread::spawn(move || protocol::writer(token, facts_rx, output_rx));
    let (control, control_rx) = mpsc::sync_channel(16);
    thread::spawn(move || {
        let stdin = io::stdin(); let mut stdin = stdin.lock(); let mut sequence = 1u32;
        loop {
            let command = protocol::read(&mut stdin, &token, sequence).and_then(|bytes| serde_json::from_slice::<Control>(&bytes).map_err(|_| protocol::invalid("invalid command")));
            let failed = command.is_err(); if control.send(command).is_err() || failed { break; }
            sequence = match sequence.checked_add(1) { Some(value) => value, None => break };
        }
    });
    send(&facts, json!({"type":"hello","protocol":1,"build":"0.1.0","architecture":std::env::consts::ARCH}))?;
    let launch = control_rx.recv_timeout(Duration::from_secs(10)).map_err(|_| protocol::invalid("launch timeout"))??;
    let Control::Launch { executable, args, cwd, environment, host_pid } = launch else { return Err(protocol::invalid("launch required")); };
    let host = windows::open_host(host_pid)?;
    if windows::ended(&host) { return Err(protocol::invalid("host already exited")); }
    let process = match windows::launch(&executable, &args, &cwd, &environment) {
        Ok(process) => process,
        Err(error) => { send(&facts, json!({"type":"launch_failed","message":error.to_string(),"effect_state":"unknown"}))?;
            thread::sleep(Duration::from_millis(30)); return Err(error); }
    };
    send(&facts, json!({"type":"started","pid":process.pid,"helper_pid":std::process::id(),"identity":process.creation}))?;
    let stop_reading = Arc::new(AtomicBool::new(false)); let (drained, drain_rx) = mpsc::sync_channel(2);
    reader(process.stdout, 2, output.clone(), drained.clone(), stop_reading.clone());
    reader(process.stderr, 3, output.clone(), drained, stop_reading.clone());
    let mut root_exited = false; let mut empty_at = None; let mut streams_closed = 0; let mut read_failed = false;
    loop {
        if windows::ended(&host) { let _ = windows::terminate(&process.job); break; }
        match control_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(Ok(Control::Terminate { request_id })) => {
                let applied = windows::terminate(&process.job).is_ok();
                send(&facts, json!({"type":"termination_ack","request_id":request_id,"applied":applied}))?;
            }
            Ok(Ok(Control::Launch { .. })) => { let _ = windows::terminate(&process.job); return Err(protocol::invalid("second launch rejected")); }
            Ok(Ok(Control::Close)) | Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => { let _ = windows::terminate(&process.job); break; }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if !root_exited && windows::ended(&process.root) {
            root_exited = true; send(&facts, json!({"type":"root_exit","code":windows::exit_code(&process.root)?}))?;
        }
        if empty_at.is_none() && windows::active(&process.job)? == 0 {
            empty_at = Some(Instant::now()); send(&facts, json!({"type":"scope_empty"}))?;
        }
        while let Ok(complete) = drain_rx.try_recv() { streams_closed += 1; read_failed |= !complete; }
        if empty_at.is_some_and(|instant| streams_closed == 2 || instant.elapsed() >= Duration::from_secs(2)) {
            stop_reading.store(true, Ordering::SeqCst);
            let (done, done_rx) = mpsc::sync_channel(1);
            let mut last = metadata(json!({"type":"output_closed","incomplete":streams_closed != 2 || read_failed})); last.done = Some(done);
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match output.try_send(last) {
                    Ok(()) => break,
                    Err(mpsc::TrySendError::Full(frame)) => {
                        if windows::ended(&host) || Instant::now() >= deadline { return Err(protocol::invalid("output drain deadline exceeded")); }
                        last = frame; thread::sleep(Duration::from_millis(10));
                    }
                    Err(mpsc::TrySendError::Disconnected(_)) => return Err(protocol::invalid("output transport closed")),
                }
            }
            let _ = done_rx.recv_timeout(Duration::from_secs(2)); break;
        }
    }
    Ok(())
}
fn send(channel: &SyncSender<Frame>, value: serde_json::Value) -> io::Result<()> {
    channel.try_send(metadata(value)).map_err(|_| protocol::invalid("lifecycle transport capacity exceeded"))
}
fn reader(mut input: impl Read + Send + 'static, kind: u8, output: SyncSender<Frame>, done: SyncSender<bool>, stopped: Arc<AtomicBool>) {
    thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        let complete = loop {
            match input.read(&mut buffer) {
                Ok(0) => break true,
                Err(_) => break false,
                Ok(length) => {
                    if stopped.load(Ordering::SeqCst) || output.send(Frame { kind, bytes: buffer[..length].to_vec(), done: None }).is_err() { break false; }
                }
            }
        };
        let _ = done.send(complete);
    });
}
