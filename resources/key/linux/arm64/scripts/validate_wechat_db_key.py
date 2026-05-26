#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Validate WeChat DB key candidates locally with SQLCipher.

This script never prints raw keys. Verified keys are written only to the local
secrets file with 0600 permissions.
"""

import argparse
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple


HEX_64_RE = re.compile(r"^[0-9a-fA-F]{64}$")
HEX_RE = re.compile(r"^[0-9a-fA-F]+$")
MIN_KEY_MATERIAL_BYTES = 32
MAX_KEY_MATERIAL_BYTES = 512


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def normalize_key(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if text.startswith("x'") and text.endswith("'"):
        text = text[2:-1]
    if text.startswith("X'") and text.endswith("'"):
        text = text[2:-1]
    if text.lower().startswith("0x"):
        text = text[2:]
    if not HEX_64_RE.match(text):
        return None
    return text.lower()


def normalize_hex_material(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if text.startswith("x'") and text.endswith("'"):
        text = text[2:-1]
    if text.startswith("X'") and text.endswith("'"):
        text = text[2:-1]
    if text.lower().startswith("0x"):
        text = text[2:]
    if len(text) % 2 or not HEX_RE.match(text):
        return None
    byte_length = len(text) // 2
    if byte_length < MIN_KEY_MATERIAL_BYTES or byte_length > MAX_KEY_MATERIAL_BYTES:
        return None
    return text.lower()


def mode_for_material_hex(material_hex: str) -> str:
    return "hexkey" if len(material_hex) == 64 else "passphrase_hex"


def load_candidates(path: Path) -> List[str]:
    if not path.exists():
        return []
    seen = set()
    candidates: List[str] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except ValueError:
            continue
        values = []
        if isinstance(payload, dict):
            values.extend([payload.get("key_hex"), payload.get("key"), payload.get("hex")])
        else:
            values.append(payload)
        for value in values:
            material = normalize_hex_material(value)
            if material and material not in seen:
                seen.add(material)
                candidates.append(material)
    return candidates


def discover_account_dirs(root: Path) -> List[Path]:
    if not root.exists():
        return []
    accounts: List[Path] = []
    for child in sorted(root.iterdir()):
        if child.is_dir() and child.name.startswith("wxid_") and (child / "db_storage").exists():
            accounts.append(child)
    return accounts


def resolve_session_db(account_dir: Path) -> Optional[Path]:
    candidates = [
        account_dir / "db_storage" / "session" / "session.db",
        account_dir / "db_storage" / "Session" / "session.db",
        account_dir / "db_storage" / "session.db",
    ]
    for path in candidates:
        if path.exists():
            return path
    for path in sorted((account_dir / "db_storage").rglob("session.db")):
        if path.is_file():
            return path
    return None


def resolve_validation_dbs(account_dir: Path) -> List[Tuple[str, Path]]:
    wanted = [
        ("session", [
            account_dir / "db_storage" / "session" / "session.db",
            account_dir / "db_storage" / "Session" / "session.db",
            account_dir / "db_storage" / "session.db",
        ]),
        ("message_0", [
            account_dir / "db_storage" / "message" / "message_0.db",
            account_dir / "db_storage" / "Message" / "message_0.db",
        ]),
        ("contact", [
            account_dir / "db_storage" / "contact" / "contact.db",
            account_dir / "db_storage" / "Contact" / "contact.db",
        ]),
        ("general", [
            account_dir / "db_storage" / "general" / "general.db",
            account_dir / "db_storage" / "General" / "general.db",
        ]),
    ]
    dbs: List[Tuple[str, Path]] = []
    seen = set()
    for label, candidates in wanted:
        for path in candidates:
            if path.exists() and str(path) not in seen:
                dbs.append((label, path))
                seen.add(str(path))
                break
    if not dbs:
        session_db = resolve_session_db(account_dir)
        if session_db:
            dbs.append(("session", session_db))
    return dbs


def sqlcipher_script_variants(hex_key: str) -> List[Tuple[str, str]]:
    key_line = "PRAGMA key = \"x'%s'\";" % hex_key
    hexkey_line = 'PRAGMA hexkey = "%s";' % hex_key
    probe = "SELECT count(*) FROM sqlite_master;"
    return [
        ("key", "\n".join([key_line, probe, ".quit\n"])),
        ("key", "\n".join(["PRAGMA cipher_compatibility = 3;", key_line, probe, ".quit\n"])),
        (
            "key",
            "\n".join(
                [
                    "PRAGMA cipher_compatibility = 3;",
                    "PRAGMA cipher_page_size = 1024;",
                    "PRAGMA kdf_iter = 64000;",
                    key_line,
                    probe,
                    ".quit\n",
                ]
            ),
        ),
        (
            "key",
            "\n".join(
                [
                    "PRAGMA cipher_compatibility = 3;",
                    "PRAGMA cipher_page_size = 4096;",
                    "PRAGMA kdf_iter = 64000;",
                    key_line,
                    probe,
                    ".quit\n",
                ]
            ),
        ),
        (
            "key",
            "\n".join(
                [
                    "PRAGMA cipher_page_size = 4096;",
                    "PRAGMA kdf_iter = 64000;",
                    key_line,
                    probe,
                    ".quit\n",
                ]
            ),
        ),
        (
            "key",
            "\n".join(
                [
                    "PRAGMA cipher_compatibility = 4;",
                    key_line,
                    probe,
                    ".quit\n",
                ]
            ),
        ),
        ("hexkey", "\n".join([hexkey_line, probe, ".quit\n"])),
        ("hexkey", "\n".join(["PRAGMA cipher_compatibility = 3;", hexkey_line, probe, ".quit\n"])),
        (
            "hexkey",
            "\n".join(
                [
                    "PRAGMA cipher_compatibility = 3;",
                    "PRAGMA cipher_page_size = 1024;",
                    hexkey_line,
                    probe,
                    ".quit\n",
                ]
            ),
        ),
        (
            "hexkey",
            "\n".join(
                [
                    "PRAGMA cipher_compatibility = 3;",
                    "PRAGMA cipher_page_size = 4096;",
                    hexkey_line,
                    probe,
                    ".quit\n",
                ]
            ),
        ),
        (
            "hexkey",
            "\n".join(
                [
                    "PRAGMA cipher_page_size = 4096;",
                    hexkey_line,
                    probe,
                    ".quit\n",
                ]
            ),
        ),
        (
            "hexkey",
            "\n".join(
                [
                    "PRAGMA cipher_compatibility = 4;",
                    hexkey_line,
                    probe,
                    ".quit\n",
                ]
            ),
        ),
    ]


def sqlcipher_scripts(hex_key: str) -> List[str]:
    return [script for _mode, script in sqlcipher_script_variants(hex_key)]


Runner = Callable[[Sequence[str], str, int], Tuple[int, str, str]]


def default_runner(command: Sequence[str], input_text: str, timeout: int) -> Tuple[int, str, str]:
    completed = subprocess.run(
        list(command),
        input=input_text,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        universal_newlines=True,
        timeout=timeout,
        check=False,
    )
    return completed.returncode, completed.stdout, completed.stderr


def try_open_db(
    sqlcipher_bin: str,
    db_path: Path,
    hex_key: str,
    runner: Optional[Runner] = None,
    timeout: int = 10,
) -> Dict[str, Any]:
    runner = runner or default_runner
    if not db_path.exists():
        return {"success": False, "error": "db_not_found"}
    for index, (mode, script) in enumerate(sqlcipher_script_variants(hex_key)):
        try:
            rc, stdout, stderr = runner([sqlcipher_bin, str(db_path)], script, timeout)
        except Exception as exc:
            return {"success": False, "error": "sqlcipher_exec_failed", "detail": str(exc)}
        if rc == 0 and stdout.strip() and "file is encrypted" not in (stdout + stderr).lower():
            return {"success": True, "variant": index, "mode": mode}
    return {"success": False, "error": "sqlcipher_open_failed"}


def load_json_object(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return {}
    return payload if isinstance(payload, dict) else {}


def write_verified_key(secrets_path: Path, account_name: str, key: str, mode: str = "key") -> None:
    if mode == "passphrase_hex":
        normalized = normalize_hex_material(key)
    else:
        normalized = normalize_key(key)
    if not normalized:
        raise ValueError("invalid key")
    if mode not in ("key", "hexkey", "passphrase_hex"):
        raise ValueError("invalid key mode")
    secrets_path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(str(secrets_path.parent), 0o700)
    data = load_json_object(secrets_path)
    if mode == "key":
        data[str(account_name)] = normalized
    else:
        data[str(account_name)] = {"key": normalized, "mode": mode}
    tmp_path = secrets_path.with_suffix(secrets_path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(str(tmp_path), 0o600)
    tmp_path.replace(secrets_path)
    os.chmod(str(secrets_path), 0o600)


def key_fingerprint(key: str) -> str:
    return hashlib.sha256(key.encode("ascii")).hexdigest()[:12]


def verify_db_key_raw_page(db_key: bytes, db_path: Path, page_size: int = 1024) -> bool:
    try:
        data = db_path.read_bytes()[:page_size]
    except OSError:
        return False
    if len(data) < page_size:
        return False
    salt = data[:16]
    first_page = data[16:page_size]
    page_key = hashlib.pbkdf2_hmac("sha1", db_key, salt, 64000, dklen=32)
    mac_salt = bytes(byte ^ 0x3A for byte in salt)
    mac_key = hashlib.pbkdf2_hmac("sha1", page_key, mac_salt, 2, dklen=32)
    digest = hmac.new(mac_key, first_page[:-32], hashlib.sha1)
    digest.update(b"\x01\x00\x00\x00")
    return hmac.compare_digest(digest.digest(), first_page[-32:-12])


def verify_db_key_raw(db_key: bytes, db_path: Path, page_sizes: Sequence[int] = (1024, 4096)) -> bool:
    return any(verify_db_key_raw_page(db_key, db_path, page_size=page_size) for page_size in page_sizes)


def verify_db_key_passphrase_v4_page(db_key: bytes, db_path: Path, page_size: int = 4096) -> bool:
    try:
        data = db_path.read_bytes()[:page_size]
    except OSError:
        return False
    if len(data) < page_size:
        return False
    salt = data[:16]
    page = data[16:page_size]
    reserve_size = 80
    hmac_size = 64
    if len(page) <= reserve_size:
        return False
    page_key = hashlib.pbkdf2_hmac("sha512", db_key, salt, 256000, dklen=32)
    mac_salt = bytes(byte ^ 0x3A for byte in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", page_key, mac_salt, 2, dklen=32)
    digest = hmac.new(mac_key, page[:-hmac_size], hashlib.sha512)
    digest.update(b"\x01\x00\x00\x00")
    return hmac.compare_digest(digest.digest(), page[-hmac_size:])


def verify_db_key_material(
    db_key: bytes,
    db_path: Path,
    page_sizes: Sequence[int] = (1024, 4096),
) -> Optional[Dict[str, Any]]:
    if verify_db_key_raw(db_key, db_path, page_sizes=page_sizes):
        return {"mode": mode_for_material_hex(db_key.hex()), "cipher_version": 3}
    if len(db_key) == 32 and 4096 in set(page_sizes) and verify_db_key_passphrase_v4_page(db_key, db_path):
        return {"mode": "passphrase_hex", "cipher_version": 4, "page_size": 4096}
    return None


def validate_candidates_fast_raw(
    account_dirs: Iterable[Path],
    candidates: Sequence[str],
    secrets_path: Path,
    db_labels: Optional[Set[str]] = None,
    page_sizes: Sequence[int] = (1024, 4096),
) -> Dict[str, Any]:
    verified: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []
    for account_dir in account_dirs:
        validation_dbs = [
            (label, db_path)
            for label, db_path in resolve_validation_dbs(account_dir)
            if not db_labels or label in db_labels
        ]
        if not validation_dbs:
            failures.append({"account": account_dir.name, "error": "validation_db_not_found"})
            continue
        matched = False
        for key in candidates:
            normalized = normalize_hex_material(key)
            if not normalized:
                continue
            key_material = bytes.fromhex(normalized)
            for db_label, db_path in validation_dbs:
                verification = verify_db_key_material(key_material, db_path, page_sizes=page_sizes)
                if verification:
                    mode = str(verification.get("mode") or mode_for_material_hex(normalized))
                    write_verified_key(secrets_path, account_dir.name, normalized, mode=mode)
                    verified.append(
                        {
                            "account": account_dir.name,
                            "db_label": db_label,
                            "cipher_version": verification.get("cipher_version"),
                            "key_fingerprint": key_fingerprint(normalized),
                            "mode": mode,
                        }
                    )
                    matched = True
                    break
            if matched:
                break
        if not matched:
            failures.append({"account": account_dir.name, "error": "no_candidate_verified_raw_page"})
    return {"success": bool(verified), "verified": verified, "failures": failures}


def validate_candidates(
    account_dirs: Iterable[Path],
    candidates: Sequence[str],
    secrets_path: Path,
    sqlcipher_bin: str,
) -> Dict[str, Any]:
    verified: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []
    for account_dir in account_dirs:
        validation_dbs = resolve_validation_dbs(account_dir)
        if not validation_dbs:
            failures.append({"account": account_dir.name, "error": "validation_db_not_found"})
            continue
        matched = False
        for key in candidates:
            for db_label, db_path in validation_dbs:
                result = try_open_db(sqlcipher_bin, db_path, key)
                if result.get("success"):
                    mode = str(result.get("mode") or "key")
                    write_verified_key(secrets_path, account_dir.name, key, mode=mode)
                    verified.append(
                        {
                            "account": account_dir.name,
                            "db_label": db_label,
                            "key_fingerprint": key_fingerprint(key),
                            "mode": mode,
                            "variant": result.get("variant"),
                        }
                    )
                    matched = True
                    break
            if matched:
                break
        if not matched:
            failures.append({"account": account_dir.name, "error": "no_candidate_opened_validation_db"})
    return {"success": bool(verified), "verified": verified, "failures": failures}


def filter_account_dirs(account_dirs: Iterable[Path], account_names: Sequence[str]) -> List[Path]:
    wanted = set(account_names)
    if not wanted:
        return list(account_dirs)
    return [account_dir for account_dir in account_dirs if account_dir.name in wanted]


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Validate local WeChat DB key candidates with SQLCipher.")
    parser.add_argument("--data-root", default="/home/lanxus/xwechat_files")
    parser.add_argument(
        "--candidates",
        default=str(skill_root() / "config" / "secrets" / "wechat_db_key_candidates.jsonl"),
    )
    parser.add_argument(
        "--secrets",
        default=str(skill_root() / "config" / "secrets" / "wechat_db_key.json"),
    )
    parser.add_argument("--sqlcipher", default="/usr/bin/sqlcipher")
    parser.add_argument("--fast-raw", action="store_true")
    parser.add_argument("--account", action="append", default=[])
    parser.add_argument("--db-label", action="append", default=[])
    parser.add_argument("--page-size", action="append", type=int, default=[])
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    candidate_keys = load_candidates(Path(args.candidates))
    account_dirs = filter_account_dirs(discover_account_dirs(Path(args.data_root)), args.account)
    if args.fast_raw:
        result = validate_candidates_fast_raw(
            account_dirs,
            candidate_keys,
            Path(args.secrets),
            db_labels=set(args.db_label) if args.db_label else None,
            page_sizes=tuple(args.page_size) if args.page_size else (1024, 4096),
        )
    else:
        result = validate_candidates(account_dirs, candidate_keys, Path(args.secrets), args.sqlcipher)
    result["candidate_count"] = len(candidate_keys)
    result["account_count"] = len(account_dirs)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print("candidate_count=%s account_count=%s verified=%s" % (
            result["candidate_count"],
            result["account_count"],
            len(result["verified"]),
        ))
        for item in result["verified"]:
            print("verified account=%s key_fingerprint=%s" % (item["account"], item["key_fingerprint"]))
        for item in result["failures"]:
            print("failed account=%s error=%s" % (item["account"], item["error"]))
    return 0 if result.get("success") else 1


if __name__ == "__main__":
    raise SystemExit(main())
