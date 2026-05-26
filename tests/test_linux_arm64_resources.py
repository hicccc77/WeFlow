import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ARM64_ROOT = ROOT / "resources" / "key" / "linux" / "arm64"
SCRIPTS = ARM64_ROOT / "scripts"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class LinuxArm64ResourcesTest(unittest.TestCase):
    def test_arm64_capture_scripts_are_packaged_resources(self):
        expected = [
            "arm64_wechat_key_hook.py",
            "validate_wechat_db_key.py",
            "wechat_db_bridge.py",
            "run_arm64_login_key_capture.sh",
            "arm64_weflow_probe_scan.c",
        ]

        for name in expected:
            path = SCRIPTS / name
            self.assertTrue(path.exists(), f"missing {path}")
            self.assertGreater(path.stat().st_size, 200)

    def test_validator_accepts_passphrase_hex_and_writes_private_secret_file(self):
        validator = load_module("validate_wechat_db_key", SCRIPTS / "validate_wechat_db_key.py")
        key = "a" * 64

        with tempfile.TemporaryDirectory() as tmp:
            secrets = Path(tmp) / "config" / "secrets" / "wechat_db_key.json"
            validator.write_verified_key(secrets, "wxid_example_abcd", key, mode="passphrase_hex")
            payload = json.loads(secrets.read_text(encoding="utf-8"))

            self.assertEqual(payload["wxid_example_abcd"], {"key": key, "mode": "passphrase_hex"})
            self.assertEqual(stat.S_IMODE(secrets.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(secrets.stat().st_mode), 0o600)

    def test_bridge_loads_passphrase_hex_without_exposing_key(self):
        bridge_module = load_module("wechat_db_bridge", SCRIPTS / "wechat_db_bridge.py")
        key = "b" * 64

        with tempfile.TemporaryDirectory() as tmp:
            secrets = Path(tmp) / "wechat_db_key.json"
            secrets.write_text(
                json.dumps({"wxid_example_abcd": {"key": key, "mode": "passphrase_hex"}}),
                encoding="utf-8",
            )
            bridge = bridge_module.WeChatDbBridge(
                {
                    "account_dirs": [],
                    "whitelist_chats": [],
                    "secrets_path": str(secrets),
                    "decrypted_cache_dir": str(Path(tmp) / "decrypted"),
                }
            )

            loaded = bridge.load_verified_keys()
            self.assertEqual(loaded["wxid_example_abcd"]["mode"], "passphrase_hex")
            self.assertEqual(loaded["wxid_example_abcd"]["key"], key)
            self.assertNotIn(key, json.dumps(bridge.health(), ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
