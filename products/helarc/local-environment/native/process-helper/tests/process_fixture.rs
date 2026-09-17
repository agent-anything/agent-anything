use std::{io::{self, Write}, process::{Command, Stdio}, thread, time::Duration};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("sleep") => thread::sleep(Duration::from_millis(args[2].parse().unwrap())),
        Some("child") => {
            let child = Command::new(std::env::current_exe().unwrap()).args(["sleep", &args[2]])
                .stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).spawn().unwrap();
            println!("child={}", child.id());
        }
        Some("output") => { println!("{}", args[2]); eprintln!("diagnostic"); }
        Some("flood") => { let bytes = [b'x'; 4096]; for _ in 0..4096 { io::stdout().write_all(&bytes).unwrap(); } }
        Some("exit") => std::process::exit(args[2].parse().unwrap()),
        _ => std::process::exit(2),
    }
}
