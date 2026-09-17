use std::io::{self, Read, Write};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::Duration;

pub const MAX_CONTROL: usize = 1_048_576;
pub const MAX_OUTPUT: usize = 65_536;
pub struct Frame {
    pub kind: u8,
    pub bytes: Vec<u8>,
    pub done: Option<SyncSender<()>>,
}

pub fn token(text: &str) -> io::Result<[u8; 16]> {
    if text.len() != 32 { return Err(invalid("invalid execution token")); }
    let mut result = [0u8; 16];
    for (index, byte) in result.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).map_err(|_| invalid("invalid token"))?;
    }
    Ok(result)
}

pub fn read(reader: &mut impl Read, token: &[u8; 16], sequence: u32) -> io::Result<Vec<u8>> {
    let mut header = [0u8; 32]; reader.read_exact(&mut header)?;
    let length = u32::from_le_bytes(header[8..12].try_into().unwrap()) as usize;
    if &header[0..4] != b"HPR1" || header[12] != 1 || header[13..16] != [0; 3] ||
        header[16..32] != *token || u32::from_le_bytes(header[4..8].try_into().unwrap()) != sequence || length > MAX_CONTROL {
        return Err(invalid("invalid control frame"));
    }
    let mut body = vec![0; length]; reader.read_exact(&mut body)?; Ok(body)
}

pub fn writer(token: [u8; 16], controls: Receiver<Frame>, output: Receiver<Frame>) {
    let stdout = io::stdout(); let mut writer = stdout.lock(); let mut sequence = 0u32;
    loop {
        let frame = match controls.try_recv() {
            Ok(frame) => frame,
            Err(_) => match output.recv_timeout(Duration::from_millis(10)) {
                Ok(frame) => frame, Err(mpsc::RecvTimeoutError::Timeout) => continue, Err(_) => return,
            },
        };
        // Facts can arrive while recv_timeout is waiting on output. Drain them
        // before that output, especially before the final capture-closed frame.
        if frame.kind != 1 || frame.done.is_some() {
            for fact in controls.try_iter() {
                if write_frame(&mut writer, &token, &mut sequence, &fact).is_err() { return; }
            }
        }
        if write_frame(&mut writer, &token, &mut sequence, &frame).is_err() { return; }
        if let Some(done) = frame.done { let _ = done.send(()); return; }
    }
}

fn write_frame(writer: &mut impl Write, token: &[u8; 16], sequence: &mut u32, frame: &Frame) -> io::Result<()> {
    *sequence = sequence.checked_add(1).ok_or_else(|| invalid("sequence exhausted"))?;
    if frame.bytes.len() > if frame.kind == 1 { MAX_CONTROL } else { MAX_OUTPUT } { return Err(invalid("oversized frame")); }
    let mut header = [0u8; 32]; header[0..4].copy_from_slice(b"HPR1");
    header[4..8].copy_from_slice(&sequence.to_le_bytes());
    header[8..12].copy_from_slice(&(frame.bytes.len() as u32).to_le_bytes());
    header[12] = frame.kind; header[16..32].copy_from_slice(token);
    writer.write_all(&header)?; writer.write_all(&frame.bytes)?; writer.flush()
}

pub fn metadata(value: serde_json::Value) -> Frame { Frame { kind: 1, bytes: serde_json::to_vec(&value).unwrap(), done: None } }
pub fn invalid(message: &str) -> io::Error { io::Error::new(io::ErrorKind::InvalidData, message) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_length_and_identity_before_allocation() {
        let mut data = [0u8; 32]; data[..4].copy_from_slice(b"HPR1"); data[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(read(&mut &data[..], &[0; 16], 1).is_err());
        assert!(token("xyz").is_err());
    }
}
