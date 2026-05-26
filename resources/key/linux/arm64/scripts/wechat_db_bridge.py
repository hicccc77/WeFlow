#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Local WeChat DB bridge for the Jipeng watcher.

This service intentionally starts with a fail-closed reader. It can read plain
SQLite fixtures for tests, but real Linux WeChat message databases on Lanxus are
encrypted/non-standard and require an ARM64 native reader before production use.
"""

import argparse
import ctypes
import ctypes.util
import hashlib
import hmac
import json
import os
import subprocess
import sqlite3
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from socketserver import ThreadingMixIn
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
from urllib.parse import parse_qs, urlparse


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def discover_account_dirs(root: Path) -> List[str]:
    if not root.exists():
        return []
    accounts: List[str] = []
    for child in sorted(root.iterdir()):
        if child.is_dir() and child.name.startswith("wxid_") and (child / "db_storage").exists():
            accounts.append(str(child))
    return accounts


def load_config(path: Path) -> Dict[str, Any]:
    raw = load_json(path, {})
    bridge = raw.get("db_bridge") if isinstance(raw.get("db_bridge"), dict) else {}
    account_dirs = bridge.get("account_dirs") if isinstance(bridge, dict) else None
    if not account_dirs:
        data_root = Path(str(bridge.get("data_root", "/home/lanxus/xwechat_files")))
        account_dirs = discover_account_dirs(data_root)
    whitelist = raw.get("whitelist_chats")
    if not isinstance(whitelist, list):
        whitelist = []
    return {
        "account_dirs": [str(item) for item in account_dirs if str(item).strip()],
        "whitelist_chats": [str(item) for item in whitelist if str(item).strip()],
        "secrets_path": str(bridge.get("secrets_path", skill_root() / "config" / "secrets" / "wechat_db_key.json")),
        "sqlcipher_bin": str(bridge.get("sqlcipher_bin", "/usr/bin/sqlcipher")),
        "decrypted_cache_dir": str(bridge.get("decrypted_cache_dir", skill_root() / "config" / "secrets" / "decrypted_dbs")),
    }


def is_sqlite_database(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(16) == b"SQLite format 3\x00"
    except OSError:
        return False


SqlcipherRunner = Callable[[Sequence[str], str, int], Tuple[int, str, str]]


def default_sqlcipher_runner(command: Sequence[str], input_text: str, timeout: int) -> Tuple[int, str, str]:
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


class AesCbcNoPadding:
    def __init__(self, key: bytes) -> None:
        lib = ctypes.CDLL(ctypes.util.find_library("crypto") or "libcrypto.so")
        lib.EVP_CIPHER_CTX_new.restype = ctypes.c_void_p
        lib.EVP_CIPHER_CTX_free.argtypes = [ctypes.c_void_p]
        lib.EVP_aes_256_cbc.restype = ctypes.c_void_p
        lib.EVP_DecryptInit_ex.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_void_p,
        ]
        lib.EVP_CIPHER_CTX_set_padding.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.EVP_DecryptUpdate.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int),
            ctypes.c_void_p,
            ctypes.c_int,
        ]
        lib.EVP_DecryptFinal_ex.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int),
        ]
        self.lib = lib
        self.key = key

    def decrypt(self, ciphertext: bytes, iv: bytes) -> bytes:
        ctx = self.lib.EVP_CIPHER_CTX_new()
        out = ctypes.create_string_buffer(len(ciphertext) + 16)
        out_len = ctypes.c_int(0)
        final_len = ctypes.c_int(0)
        try:
            if self.lib.EVP_DecryptInit_ex(ctx, self.lib.EVP_aes_256_cbc(), None, self.key, iv) != 1:
                raise RuntimeError("openssl_init_failed")
            self.lib.EVP_CIPHER_CTX_set_padding(ctx, 0)
            if self.lib.EVP_DecryptUpdate(ctx, out, ctypes.byref(out_len), ciphertext, len(ciphertext)) != 1:
                raise RuntimeError("openssl_update_failed")
            if self.lib.EVP_DecryptFinal_ex(ctx, ctypes.byref(out, out_len.value), ctypes.byref(final_len)) != 1:
                raise RuntimeError("openssl_final_failed")
            return out.raw[: out_len.value + final_len.value]
        finally:
            self.lib.EVP_CIPHER_CTX_free(ctx)


def decrypt_sqlcipher_v4_file(db_path: Path, output_path: Path, passphrase: bytes) -> None:
    page_size = 4096
    reserve_size = 80
    hmac_size = 64
    data = db_path.read_bytes()
    if len(data) < page_size or len(data) % page_size != 0:
        raise RuntimeError("unsupported_sqlcipher_v4_db_size")
    salt = data[:16]
    page_key = hashlib.pbkdf2_hmac("sha512", passphrase, salt, 256000, dklen=32)
    mac_key = hashlib.pbkdf2_hmac(
        "sha512",
        page_key,
        bytes(byte ^ 0x3A for byte in salt),
        2,
        dklen=32,
    )
    aes = AesCbcNoPadding(page_key)
    with output_path.open("wb") as writer:
        page_count = len(data) // page_size
        for page_no in range(1, page_count + 1):
            encrypted = data[(page_no - 1) * page_size : page_no * page_size]
            if page_no != 1 and encrypted == b"\x00" * page_size:
                writer.write(b"\x00" * page_size)
                continue
            body = encrypted[16:] if page_no == 1 else encrypted
            digest = hmac.new(
                mac_key,
                body[:-hmac_size] + page_no.to_bytes(4, "little"),
                hashlib.sha512,
            ).digest()
            if not hmac.compare_digest(digest, body[-hmac_size:]):
                raise RuntimeError("sqlcipher_v4_hmac_failed_page_%d" % page_no)
            ciphertext = body[:-reserve_size]
            iv = body[-reserve_size : -reserve_size + 16]
            plaintext = aes.decrypt(ciphertext, iv)
            if page_no == 1:
                output_page = b"SQLite format 3\x00" + plaintext + (b"\x00" * reserve_size)
            else:
                output_page = plaintext + (b"\x00" * reserve_size)
            if len(output_page) != page_size:
                raise RuntimeError("sqlcipher_v4_plain_page_size_mismatch")
            writer.write(output_page)


class WeChatDbBridge:
    def __init__(self, config: Dict[str, Any], sqlcipher_runner: SqlcipherRunner = default_sqlcipher_runner) -> None:
        self.account_dirs = [Path(str(item)) for item in config.get("account_dirs", [])]
        self.whitelist_chats = set(str(item) for item in config.get("whitelist_chats", []))
        self.secrets_path = Path(str(config.get("secrets_path", skill_root() / "config" / "secrets" / "wechat_db_key.json")))
        self.sqlcipher_bin = str(config.get("sqlcipher_bin", "/usr/bin/sqlcipher"))
        self.decrypted_cache_dir = Path(str(config.get("decrypted_cache_dir", skill_root() / "config" / "secrets" / "decrypted_dbs")))
        self.sqlcipher_runner = sqlcipher_runner

    def health(self) -> Dict[str, Any]:
        existing_accounts = [str(path) for path in self.account_dirs if path.exists()]
        return {
            "success": True,
            "account_count": len(existing_accounts),
            "whitelist_count": len(self.whitelist_chats),
            "reader": "sqlcipher_v4_or_plain_sqlite",
            "verified_key_count": len(self.load_verified_keys()),
        }

    def sessions(self) -> Dict[str, Any]:
        return {
            "success": True,
            "sessions": [{"chat_name": chat_name} for chat_name in sorted(self.whitelist_chats)],
        }

    def messages(
        self,
        chat_name: str,
        *,
        limit: int = 20,
        since_id: Optional[str] = None,
        since_time: Optional[str] = None,
    ) -> Dict[str, Any]:
        if self.whitelist_chats and chat_name not in self.whitelist_chats:
            return {"success": False, "error": "chat_not_whitelisted"}
        db_paths = self.message_db_paths()
        if not db_paths:
            return {"success": False, "error": "message_db_not_found"}
        encrypted_seen = False
        all_messages: List[Dict[str, Any]] = []
        verified_keys = self.load_verified_keys()
        for db_path in db_paths:
            if not is_sqlite_database(db_path):
                encrypted_seen = True
                account_name = self.account_name_for_db(db_path)
                key = verified_keys.get(account_name)
                if key:
                    if key.get("mode") == "passphrase_hex":
                        rows = self.read_sqlcipher_v4_messages(db_path, key, chat_name, limit, since_id, since_time)
                    else:
                        rows = self.read_sqlcipher_messages(db_path, key, chat_name, limit, since_id, since_time)
                    all_messages.extend(rows)
                continue
            rows = self.read_plain_fixture_messages(db_path, chat_name, limit, since_id, since_time)
            all_messages.extend(rows)
        if not all_messages and encrypted_seen:
            return {"success": False, "error": "encrypted_db_reader_unavailable"}
        all_messages.sort(key=lambda row: (int(row.get("created_at") or 0), str(row.get("message_id") or "")))
        return {"success": True, "messages": all_messages[-limit:]}

    def attachments(self, message_id: str) -> Dict[str, Any]:
        attachments: List[Dict[str, Any]] = []
        for db_path in self.message_db_paths():
            if not is_sqlite_database(db_path):
                continue
            attachments.extend(self.read_plain_fixture_attachments(db_path, message_id))
        return {"success": True, "message_id": message_id, "attachments": attachments}

    def message_db_paths(self) -> List[Path]:
        paths: List[Path] = []
        for account_dir in self.account_dirs:
            message_dir = account_dir / "db_storage" / "message"
            paths.extend(sorted(message_dir.glob("message_*.db")))
        return paths

    def account_name_for_db(self, db_path: Path) -> str:
        for account_dir in self.account_dirs:
            try:
                db_path.relative_to(account_dir)
                return account_dir.name
            except ValueError:
                continue
        return ""

    def account_dir_for_db(self, db_path: Path) -> Optional[Path]:
        for account_dir in self.account_dirs:
            try:
                db_path.relative_to(account_dir)
                return account_dir
            except ValueError:
                continue
        return None

    def load_verified_keys(self) -> Dict[str, Dict[str, str]]:
        if not self.secrets_path.exists():
            return {}
        try:
            payload = json.loads(self.secrets_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if not isinstance(payload, dict):
            return {}
        keys: Dict[str, Dict[str, str]] = {}
        for account, value in payload.items():
            mode = "key"
            raw_value: Any = value
            if isinstance(value, dict):
                mode = str(value.get("mode") or "key")
                raw_value = value.get("key")
            text = str(raw_value or "").strip().lower()
            if (
                len(text) >= 64
                and len(text) <= 1024
                and len(text) % 2 == 0
                and all(ch in "0123456789abcdef" for ch in text)
            ):
                if mode not in ("key", "hexkey", "passphrase_hex"):
                    mode = "key"
                keys[str(account)] = {"key": text, "mode": mode}
        return keys

    def sqlcipher_script(self, key_info: Any, sql: str) -> str:
        if isinstance(key_info, dict):
            key_hex = str(key_info.get("key") or "").strip().lower()
            mode = str(key_info.get("mode") or "key")
        else:
            key_hex = str(key_info or "").strip().lower()
            mode = "key"
        if mode == "hexkey":
            key_pragma = 'PRAGMA hexkey = "%s";' % key_hex
        elif mode == "passphrase_hex":
            key_pragma = "PRAGMA key = \"x'%s'\";" % key_hex
        else:
            key_pragma = "PRAGMA key = \"x'%s'\";" % key_hex
        return "\n".join(
            [
                "PRAGMA cipher_compatibility = 4;" if mode == "passphrase_hex" else "PRAGMA cipher_compatibility = 3;",
                key_pragma,
                sql,
                ".quit",
                "",
            ]
        )

    def run_sqlcipher(self, db_path: Path, key_hex: str, sql: str, timeout: int = 8) -> Optional[str]:
        try:
            rc, stdout, stderr = self.sqlcipher_runner(
                [self.sqlcipher_bin, str(db_path)],
                self.sqlcipher_script(key_hex, sql),
                timeout,
            )
        except Exception:
            return None
        if rc != 0 or "file is encrypted" in (stdout + stderr).lower():
            return None
        return stdout

    def read_sqlcipher_messages(
        self,
        db_path: Path,
        key_hex: str,
        chat_name: str,
        limit: int,
        since_id: Optional[str],
        since_time: Optional[str],
    ) -> List[Dict[str, Any]]:
        table_names = self.sqlcipher_table_names(db_path, key_hex)
        for table_name in table_names:
            columns = self.sqlcipher_table_columns(db_path, key_hex, table_name)
            plan = self.message_query_plan(table_name, columns)
            if not plan:
                continue
            rows = self.sqlcipher_message_rows(db_path, key_hex, plan, chat_name, limit, since_time)
            if since_id:
                rows = [row for row in rows if str(row.get("message_id")) != str(since_id)]
            if rows:
                return rows
        return []

    def sqlcipher_table_names(self, db_path: Path, key_hex: str) -> List[str]:
        stdout = self.run_sqlcipher(
            db_path,
            key_hex,
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
        )
        if stdout is None:
            return []
        return [line.strip() for line in stdout.splitlines() if line.strip()]

    def sqlcipher_table_columns(self, db_path: Path, key_hex: str, table_name: str) -> List[str]:
        stdout = self.run_sqlcipher(db_path, key_hex, 'PRAGMA table_info("%s");' % table_name.replace('"', '""'))
        if stdout is None:
            return []
        columns: List[str] = []
        for line in stdout.splitlines():
            parts = line.split("\t")
            if len(parts) >= 2:
                columns.append(parts[1])
            else:
                pipe_parts = line.split("|")
                if len(pipe_parts) >= 2:
                    columns.append(pipe_parts[1])
        return columns

    def message_query_plan(self, table_name: str, columns: Sequence[str]) -> Optional[Dict[str, str]]:
        column_set = set(columns)
        candidates = [
            {
                "message_id": "message_id",
                "chat_name": "chat_name",
                "sender_name": "sender_name",
                "content_type": "content_type",
                "text": "text",
                "created_at": "created_at",
            },
            {
                "message_id": "msgSvrId",
                "chat_name": "talker",
                "sender_name": "sender",
                "content_type": "type",
                "text": "content",
                "created_at": "createTime",
            },
            {
                "message_id": "mesSvrID",
                "chat_name": "talker",
                "sender_name": "sender",
                "content_type": "msgType",
                "text": "msgContent",
                "created_at": "msgCreateTime",
            },
        ]
        for candidate in candidates:
            required = ["message_id", "text", "created_at"]
            if all(candidate[name] in column_set for name in required):
                return {"table": table_name, **candidate}
        return None

    def quote_identifier(self, value: str) -> str:
        return '"' + value.replace('"', '""') + '"'

    def quote_literal(self, value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    def sqlcipher_message_rows(
        self,
        db_path: Path,
        key_hex: str,
        plan: Dict[str, str],
        chat_name: str,
        limit: int,
        since_time: Optional[str],
    ) -> List[Dict[str, Any]]:
        select_pairs = [
            ("message_id", plan["message_id"]),
            ("chat_name", plan["chat_name"]),
            ("sender_name", plan["sender_name"]),
            ("content_type", plan["content_type"]),
            ("text", plan["text"]),
            ("created_at", plan["created_at"]),
        ]
        where = []
        if plan["chat_name"]:
            where.append("%s = %s" % (self.quote_identifier(plan["chat_name"]), self.quote_literal(chat_name)))
        if since_time:
            where.append("%s > %d" % (self.quote_identifier(plan["created_at"]), int(float(since_time))))
        sql = (
            ".mode tabs\n"
            "SELECT %s FROM %s%s ORDER BY %s ASC LIMIT %d;"
            % (
                ", ".join("%s AS %s" % (self.quote_identifier(column), alias) for alias, column in select_pairs),
                self.quote_identifier(plan["table"]),
                (" WHERE " + " AND ".join(where)) if where else "",
                self.quote_identifier(plan["created_at"]),
                max(1, int(limit)),
            )
        )
        stdout = self.run_sqlcipher(db_path, key_hex, sql)
        if stdout is None:
            return []
        rows: List[Dict[str, Any]] = []
        aliases = [alias for alias, _column in select_pairs]
        for line in stdout.splitlines():
            if not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) != len(aliases):
                continue
            row = {aliases[index]: parts[index] for index in range(len(aliases))}
            try:
                row["created_at"] = int(float(row.get("created_at") or 0))
            except ValueError:
                row["created_at"] = 0
            rows.append(row)
        return rows

    def cache_path_for_db(self, db_path: Path) -> Path:
        account_dir = self.account_dir_for_db(db_path)
        if account_dir is None:
            name = db_path.name
            account_name = "unknown"
        else:
            account_name = account_dir.name
            try:
                name = str(db_path.relative_to(account_dir))
            except ValueError:
                name = db_path.name
        safe_name = name.replace("/", "__")
        return self.decrypted_cache_dir / account_name / safe_name

    def decrypt_sqlcipher_v4_to_cache(self, db_path: Path, key_info: Dict[str, str]) -> Optional[Path]:
        key_hex = str(key_info.get("key") or "").strip().lower()
        if len(key_hex) != 64:
            return None
        cache_path = self.cache_path_for_db(db_path)
        source_mtime = db_path.stat().st_mtime
        if cache_path.exists() and cache_path.stat().st_mtime >= source_mtime and is_sqlite_database(cache_path):
            return cache_path
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(str(self.decrypted_cache_dir), 0o700)
        os.chmod(str(cache_path.parent), 0o700)
        tmp_path = cache_path.with_suffix(cache_path.suffix + ".tmp")
        try:
            decrypt_sqlcipher_v4_file(db_path, tmp_path, bytes.fromhex(key_hex))
            os.chmod(str(tmp_path), 0o600)
            tmp_path.replace(cache_path)
            os.chmod(str(cache_path), 0o600)
        except Exception:
            try:
                tmp_path.unlink()
            except OSError:
                pass
            return None
        return cache_path if is_sqlite_database(cache_path) else None

    def read_sqlcipher_v4_messages(
        self,
        db_path: Path,
        key_info: Dict[str, str],
        chat_name: str,
        limit: int,
        since_id: Optional[str],
        since_time: Optional[str],
    ) -> List[Dict[str, Any]]:
        message_cache = self.decrypt_sqlcipher_v4_to_cache(db_path, key_info)
        if message_cache is None:
            return []
        account_dir = self.account_dir_for_db(db_path)
        contact_cache: Optional[Path] = None
        if account_dir is not None:
            contact_db = account_dir / "db_storage" / "contact" / "contact.db"
            if contact_db.exists() and not is_sqlite_database(contact_db):
                contact_cache = self.decrypt_sqlcipher_v4_to_cache(contact_db, key_info)
            elif contact_db.exists():
                contact_cache = contact_db
        return self.read_wechat_message_tables(message_cache, contact_cache, chat_name, limit, since_id, since_time)

    def read_wechat_message_tables(
        self,
        message_db: Path,
        contact_db: Optional[Path],
        chat_name: str,
        limit: int,
        since_id: Optional[str],
        since_time: Optional[str],
    ) -> List[Dict[str, Any]]:
        conn = sqlite3.connect(str(message_db))
        conn.row_factory = sqlite3.Row
        contact_conn: Optional[sqlite3.Connection] = None
        try:
            if contact_db and contact_db.exists():
                contact_conn = sqlite3.connect(str(contact_db))
                contact_conn.row_factory = sqlite3.Row
            username = self.resolve_wechat_username(conn, contact_conn, chat_name)
            if not username:
                return []
            table_name = "Msg_" + hashlib.md5(username.encode("utf-8")).hexdigest()
            table_exists = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
                [table_name],
            ).fetchone()
            if not table_exists:
                return []
            params: List[Any] = []
            where: List[str] = []
            if since_time:
                where.append("create_time > ?")
                params.append(int(float(since_time)))
            sql = (
                "SELECT local_id, server_id, local_type, real_sender_id, create_time, message_content "
                "FROM %s%s ORDER BY create_time ASC LIMIT ?"
                % (
                    self.quote_identifier(table_name),
                    (" WHERE " + " AND ".join(where)) if where else "",
                )
            )
            params.append(max(1, int(limit)))
            id_to_username = self.message_name_id_map(conn)
            rows: List[Dict[str, Any]] = []
            for row in conn.execute(sql, params):
                message_id = str(row["server_id"] or row["local_id"])
                if since_id and message_id == str(since_id):
                    continue
                sender_username = id_to_username.get(int(row["real_sender_id"] or 0), "")
                rows.append(
                    {
                        "message_id": message_id,
                        "chat_name": chat_name,
                        "sender_name": self.display_name_for_username(contact_conn, sender_username) or sender_username,
                        "content_type": str(row["local_type"]),
                        "text": row["message_content"] or "",
                        "created_at": int(row["create_time"] or 0),
                    }
                )
            return rows
        finally:
            if contact_conn is not None:
                contact_conn.close()
            conn.close()

    def message_name_id_map(self, conn: sqlite3.Connection) -> Dict[int, str]:
        try:
            return {
                int(row["rowid"]): str(row["user_name"] or "")
                for row in conn.execute("SELECT rowid, user_name FROM Name2Id")
            }
        except sqlite3.Error:
            return {}

    def resolve_wechat_username(
        self,
        message_conn: sqlite3.Connection,
        contact_conn: Optional[sqlite3.Connection],
        chat_name: str,
    ) -> Optional[str]:
        if not chat_name:
            return None
        try:
            row = message_conn.execute("SELECT user_name FROM Name2Id WHERE user_name = ? LIMIT 1", [chat_name]).fetchone()
            if row:
                return str(row["user_name"])
        except sqlite3.Error:
            pass
        if contact_conn is not None:
            try:
                row = contact_conn.execute(
                    """
                    SELECT username FROM contact
                    WHERE username = ? OR remark = ? OR nick_name = ?
                    ORDER BY CASE WHEN remark = ? THEN 0 WHEN nick_name = ? THEN 1 ELSE 2 END
                    LIMIT 1
                    """,
                    [chat_name, chat_name, chat_name, chat_name, chat_name],
                ).fetchone()
                if row:
                    return str(row["username"])
            except sqlite3.Error:
                pass
        return None

    def display_name_for_username(self, contact_conn: Optional[sqlite3.Connection], username: str) -> str:
        if not username or contact_conn is None:
            return ""
        try:
            row = contact_conn.execute(
                "SELECT remark, nick_name FROM contact WHERE username = ? LIMIT 1",
                [username],
            ).fetchone()
            if not row:
                return ""
            return str(row["remark"] or row["nick_name"] or "")
        except sqlite3.Error:
            return ""

    def read_plain_fixture_messages(
        self,
        db_path: Path,
        chat_name: str,
        limit: int,
        since_id: Optional[str],
        since_time: Optional[str],
    ) -> List[Dict[str, Any]]:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            table_names = {
                row["name"]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            }
            if "messages" not in table_names:
                return []
            params: List[Any] = [chat_name]
            where = ["chat_name = ?"]
            if since_time:
                where.append("created_at > ?")
                params.append(int(float(since_time)))
            sql = (
                "SELECT message_id, chat_name, sender_name, content_type, text, created_at "
                "FROM messages WHERE %s ORDER BY created_at ASC LIMIT ?"
                % " AND ".join(where)
            )
            params.append(limit)
            rows = [dict(row) for row in conn.execute(sql, params)]
            if since_id:
                rows = [row for row in rows if str(row.get("message_id")) != str(since_id)]
            return rows
        finally:
            conn.close()

    def read_plain_fixture_attachments(self, db_path: Path, message_id: str) -> List[Dict[str, Any]]:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            table_names = {
                row["name"]
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            }
            if "attachments" not in table_names:
                return []
            rows = conn.execute(
                """
                SELECT message_id, attachment_id, kind, path, file_name, size
                FROM attachments
                WHERE message_id = ?
                ORDER BY attachment_id ASC
                """,
                [message_id],
            )
            return [dict(row) for row in rows]
        finally:
            conn.close()


class BridgeHandler(BaseHTTPRequestHandler):
    bridge: WeChatDbBridge

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/health":
            self.send_json(self.bridge.health())
            return
        if parsed.path == "/sessions":
            self.send_json(self.bridge.sessions())
            return
        if parsed.path == "/messages":
            chat = (query.get("chat") or [""])[0]
            limit_raw = (query.get("limit") or ["20"])[0]
            since_id = (query.get("since_id") or [None])[0]
            since_time = (query.get("since_time") or [None])[0]
            try:
                limit = max(1, int(limit_raw))
            except ValueError:
                limit = 20
            self.send_json(self.bridge.messages(chat, limit=limit, since_id=since_id, since_time=since_time))
            return
        if parsed.path == "/attachments":
            message_id = (query.get("message_id") or [""])[0]
            self.send_json(self.bridge.attachments(message_id))
            return
        self.send_json({"success": False, "error": "not_found"}, status=404)

    def log_message(self, format: str, *args: Any) -> None:
        return

    def send_json(self, payload: Dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_server(config: Dict[str, Any], host: str, port: int) -> None:
    bridge = WeChatDbBridge(config)

    class Handler(BridgeHandler):
        pass

    Handler.bridge = bridge
    server = ThreadingHTTPServer((host, port), Handler)
    server.serve_forever()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Serve local WeChat DB messages to the Jipeng watcher.")
    parser.add_argument("--config", default=str(skill_root() / "config" / "wechat_monitor.json"))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5032)
    parser.add_argument("--health", action="store_true", help="Print health JSON and exit.")
    args = parser.parse_args(argv)

    config = load_config(Path(args.config))
    if args.health:
        print(json.dumps(WeChatDbBridge(config).health(), ensure_ascii=False, indent=2))
        return 0
    run_server(config, args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
