// Test-only OS fixture. Not packaged with the application and never accepts user keys.
use std::ptr::null_mut;
use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, GetLastError};
use windows_sys::Win32::Security::Credentials::{CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC, CredDeleteW, CredFree, CredReadW, CredWriteW};

fn run() -> Result<(), &'static str> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 { return Err("arguments"); }
    let suffix = args[2].strip_prefix("Helarc-Custody-Test/").ok_or("target")?;
    if suffix.len() != 36 || !suffix.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') { return Err("target"); }
    let mut target: Vec<u16> = args[2].encode_utf16().chain([0]).collect();
    let mut existing: *mut CREDENTIALW = null_mut();
    let present = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut existing) } != 0;
    if !present && unsafe { GetLastError() } != ERROR_NOT_FOUND { return Err("read"); }
    if present {
        let record = unsafe { &*existing };
        let first: Vec<u8> = "synthetic-custody-verification-key".encode_utf16().flat_map(u16::to_le_bytes).collect();
        let changed: Vec<u8> = "synthetic-external-change".encode_utf16().flat_map(u16::to_le_bytes).collect();
        let known = if record.CredentialBlobSize == 0 || record.CredentialBlobSize > 2560 || record.CredentialBlob.is_null() { false }
            else { let bytes = unsafe { std::slice::from_raw_parts(record.CredentialBlob, record.CredentialBlobSize as usize) }; bytes == first || bytes == changed };
        unsafe { CredFree(existing.cast()); }
        if !known { return Err("not_fixture_content"); }
    }
    if args[1] == "delete" {
        if present && unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 { return Err("delete"); }
        return Ok(());
    }
    if present { return Err("exists"); }
    let secret = match args[1].as_str() {
        "create" => "synthetic-custody-verification-key",
        "changed" => "synthetic-external-change",
        _ => return Err("operation"),
    };
    let mut blob: Vec<u16> = secret.encode_utf16().collect();
    let mut user: Vec<u16> = "Helarc custody test only".encode_utf16().chain([0]).collect();
    let credential = CREDENTIALW { Type: CRED_TYPE_GENERIC, TargetName: target.as_mut_ptr(),
        CredentialBlobSize: (blob.len()*2) as u32, CredentialBlob: blob.as_mut_ptr().cast(),
        Persist: CRED_PERSIST_LOCAL_MACHINE, UserName: user.as_mut_ptr(), ..unsafe { std::mem::zeroed() } };
    if unsafe { CredWriteW(&credential, 0) } == 0 { return Err("write"); }
    Ok(())
}
fn main() {
    if let Err(code) = run() { eprintln!("credential_fixture_{code}"); std::process::exit(1); }
}
