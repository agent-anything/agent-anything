use serde::Deserialize;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::ptr::{null_mut, write_volatile};
use windows_sys::Win32::Foundation::{ERROR_NOT_FOUND, GetLastError};
use windows_sys::Win32::Security::Credentials::{CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC, CredDeleteW, CredFree, CredReadW, CredWriteW};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request { operation: String, target: String, encoding: Option<String>, secret: Option<String> }

struct Credential(*mut CREDENTIALW);
impl Drop for Credential { fn drop(&mut self) { unsafe { CredFree(self.0.cast()); } } }

fn read(target: &[u16]) -> Result<Option<Credential>, &'static str> {
    let mut ptr = null_mut();
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut ptr) } == 0 {
        return if unsafe { GetLastError() } == ERROR_NOT_FOUND { Ok(None) } else { Err("access_failed") };
    }
    Ok(Some(Credential(ptr)))
}

fn execute(r: Request) -> Result<Value, &'static str> {
    if r.target.is_empty() || r.target.encode_utf16().count() > 2048 ||
        r.target.trim() != r.target || r.target.chars().any(|c| c.is_control()) { return Err("invalid_target"); }
    let mut target: Vec<u16> = r.target.encode_utf16().chain([0]).collect();
    if r.operation == "read" {
        if r.secret.is_some() { return Err("invalid_request"); }
        let Some(record) = read(&target)? else { return Ok(json!({"ok":true,"secret":null})); };
        let c = unsafe { &*record.0 };
        if c.CredentialBlobSize > 2560 || (c.CredentialBlobSize > 0 && c.CredentialBlob.is_null()) { return Err("invalid_blob"); }
        let bytes = if c.CredentialBlobSize == 0 { &[] } else { unsafe { std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize) } };
        let secret = decode_secret(bytes, r.encoding.as_deref())?;
        return Ok(json!({"ok":true,"secret":secret}));
    }
    // Mutations are restricted to generated Helarc-owned targets.
    let suffix = r.target.strip_prefix("Helarc/Provider/").ok_or("target_not_owned")?;
    if !suffix.starts_with("provider-") || suffix.len() != 82 ||
        !suffix[9..].bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') || r.encoding.is_some() { return Err("target_not_owned"); }
    match r.operation.as_str() {
        "create" => {
            if read(&target)?.is_some() { return Err("target_exists"); }
            let secret = r.secret.ok_or("invalid_secret")?;
            let mut blob: Vec<u16> = secret.encode_utf16().collect();
            if blob.is_empty() || blob.len() > 1280 || secret.contains(['\0','\r','\n']) { return Err("invalid_secret"); }
            let mut user: Vec<u16> = "Helarc".encode_utf16().chain([0]).collect();
            let credential = CREDENTIALW { Type: CRED_TYPE_GENERIC, TargetName: target.as_mut_ptr(),
                CredentialBlobSize: (blob.len()*2) as u32, CredentialBlob: blob.as_mut_ptr().cast(),
                Persist: CRED_PERSIST_LOCAL_MACHINE, UserName: user.as_mut_ptr(), ..unsafe { std::mem::zeroed() } };
            let ok = unsafe { CredWriteW(&credential, 0) };
            for unit in &mut blob { unsafe { write_volatile(unit, 0); } }
            if ok == 0 { return Err("write_failed"); }
        },
        "delete" if r.secret.is_none() => {
            if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 && unsafe { GetLastError() } != ERROR_NOT_FOUND {
                return Err("delete_failed");
            }
        },
        _ => return Err("invalid_request"),
    }
    Ok(json!({"ok":true}))
}

fn decode_secret(bytes: &[u8], encoding: Option<&str>) -> Result<String, &'static str> {
    let secret = match encoding {
        Some("utf16le") if bytes.len() % 2 == 0 => {
            let units: Vec<u16> = bytes.chunks_exact(2).map(|b| u16::from_le_bytes([b[0],b[1]])).collect();
            String::from_utf16(&units).map_err(|_| "invalid_encoding")?
        },
        Some("utf8") => String::from_utf8(bytes.to_vec()).map_err(|_| "invalid_encoding")?,
        _ => return Err("invalid_encoding"),
    };
    if secret.is_empty() || secret.contains(['\0','\r','\n']) { return Err("invalid_secret"); }
    Ok(secret)
}

fn main() {
    let result = (|| {
        let mut input = Vec::new();
        std::io::stdin().take(32769).read_to_end(&mut input).map_err(|_| "input_failed")?;
        if input.len() > 32768 { return Err("input_too_large"); }
        let request = serde_json::from_slice(&input).map_err(|_| "invalid_request")?;
        execute(request)
    })();
    let response = result.unwrap_or_else(|code| json!({"ok":false,"code":code}));
    let _ = serde_json::to_writer(std::io::stdout().lock(), &response);
    let _ = std::io::stdout().flush();
}

#[cfg(test)]
mod tests {
    use super::decode_secret;
    #[test]
    fn explicit_blob_encoding_is_strict() {
        let secret = "dummy-\u{4e2d}\u{6587}-key";
        let utf16: Vec<u8> = secret.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decode_secret(&utf16, Some("utf16le")).unwrap(), secret);
        assert_eq!(decode_secret(secret.as_bytes(), Some("utf8")).unwrap(), secret);
        assert!(decode_secret(&[0xff], Some("utf8")).is_err());
        assert!(decode_secret(&[0x00,0xd8], Some("utf16le")).is_err());
        assert!(decode_secret(&[0x61], Some("utf16le")).is_err());
        assert!(decode_secret(b"key\0", Some("utf8")).is_err());
        assert!(decode_secret(b"key", None).is_err());
    }
}
