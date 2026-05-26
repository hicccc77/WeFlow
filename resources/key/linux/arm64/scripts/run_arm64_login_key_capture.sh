#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="${WEFLOW_ARM64_STATE_DIR:-$HOME/.local/share/weflow-arm64}"
CANDIDATES_PATH="${WEFLOW_ARM64_CANDIDATES_PATH:-$STATE_DIR/secrets/wechat_db_key_candidates.jsonl}"
SECRETS_PATH="${WEFLOW_ARM64_SECRETS_PATH:-$STATE_DIR/secrets/wechat_db_key.json}"
DATA_ROOT="${WEFLOW_ARM64_WECHAT_DATA_ROOT:-$HOME/xwechat_files}"
LOG_PATH="${WEFLOW_ARM64_LOG_PATH:-$STATE_DIR/logs/arm64_login_key_capture.log}"
DURATION_SEC=300
STARTUP_SLEEP_SEC=20
TIMER_WAS_ACTIVE=0
TARGET_OFFSETS=()
ACCOUNT_ARGS=()
DB_LABEL_ARGS=(--db-label message_0 --db-label session --db-label contact --db-label general)
PAGE_SIZE_ARGS=(--page-size 1024 --page-size 4096)

usage() {
  cat <<'EOF'
Usage: run_arm64_login_key_capture.sh [--duration-sec SEC] [--target-offset OFFSET] [--account ACCOUNT_DIR_NAME] [--data-root PATH]

Restart WeChat with a short startup pause, install ARM64 login-time key hooks,
and wait for a verified DB key. Log in only after the script prints hook_ready.
Raw keys are never printed.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration-sec)
      DURATION_SEC="$2"
      shift 2
      ;;
    --target-offset)
      TARGET_OFFSETS+=("$2")
      shift 2
      ;;
    --account)
      ACCOUNT_ARGS+=(--account "$2")
      shift 2
      ;;
    --data-root)
      DATA_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

restore_timer() {
  if [[ "$TIMER_WAS_ACTIVE" -eq 1 ]]; then
    systemctl --user start jipeng-wechat-watch.timer >/dev/null 2>&1 || true
  fi
}
trap restore_timer EXIT

cd "$SKILL_DIR"
mkdir -p "$(dirname "$CANDIDATES_PATH")" "$(dirname "$LOG_PATH")"
chmod 700 "$(dirname "$CANDIDATES_PATH")"
if [[ -s "$CANDIDATES_PATH" ]]; then
  mv "$CANDIDATES_PATH" "$CANDIDATES_PATH.$(date +%Y%m%d%H%M%S).bak"
fi
touch "$CANDIDATES_PATH"
chmod 600 "$CANDIDATES_PATH"
touch "$LOG_PATH"
chmod 600 "$LOG_PATH"

if systemctl --user is-active --quiet jipeng-wechat-watch.timer; then
  TIMER_WAS_ACTIVE=1
  systemctl --user stop jipeng-wechat-watch.timer || true
fi

pkill -TERM -x wechat >/dev/null 2>&1 || true
pkill -TERM -f 'WeChatAppEx|/opt/wechat/wechat|/usr/bin/wechat' >/dev/null 2>&1 || true
sleep 2
pkill -KILL -x wechat >/dev/null 2>&1 || true

WECHAT_BIN="${WEFLOW_WECHAT_BIN:-}"
if [[ -z "$WECHAT_BIN" ]]; then
  for candidate in /opt/wechat/wechat /usr/bin/wechat /usr/local/bin/wechat wechat; do
    if command -v "$candidate" >/dev/null 2>&1 || [[ -x "$candidate" ]]; then
      WECHAT_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$WECHAT_BIN" ]]; then
  echo '{"event":"error","error":"wechat_binary_not_found"}'
  exit 1
fi

(
  export DISPLAY="${DISPLAY:-:0}"
  export XAUTHORITY="${XAUTHORITY:-/home/lanxus/.Xauthority}"
  export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}"
  export QTWEBENGINE_CHROMIUM_FLAGS="${QTWEBENGINE_CHROMIUM_FLAGS:---no-sandbox --disable-es3-gl-context --ignore-gpu-blacklist --ignore-gpu-blocklist --enable-accelerated-video-decode}"
  {
    echo "[$(date -Is)] starting $WECHAT_BIN for login key capture"
    echo "DISPLAY=$DISPLAY"
    echo "XAUTHORITY=$XAUTHORITY"
    echo "DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS"
  } >> "$LOG_PATH"
  "$WECHAT_BIN" >> "$LOG_PATH" 2>&1 &
)

sleep 2
PID="$(pgrep -n -x wechat || true)"
if [[ -z "$PID" ]]; then
  echo '{"event":"error","error":"wechat_pid_not_found"}'
  exit 1
fi

if [[ "${#TARGET_OFFSETS[@]}" -eq 0 ]]; then
  TARGET_OFFSETS=(
    # Downstream SQLCipher/WCDB key copy path: x1=key bytes, x2=length.
    0x665e4e0
    0x665e568
    0x665eed4
    0x6642024
    # Callers of the sqlite3_key_v2-like path found from the ARM64 binary.
    0x6679e3c
    0x668c9f8
    0x668cd50
    0x668cd70
    0x668cd8c
    0x6642390
    # WeFlow-style sink: function consuming com.Tencent.WCDB.Config.Cipher.
    0x6498834
    # Nearby config insertion / object construction path.
    0x64b3398
    0x64ac398
    0x64ddc78
    # Lower WCDB key/config paths observed during login.
    0x6641f98
    0x66421f0
    0x665eba8
    # Earlier ARM64 scan fallbacks.
    0x64bbea8
    0x64bc260
  )
fi

if [[ "${#TARGET_OFFSETS[@]}" -eq 0 ]]; then
  echo '{"event":"error","error":"weflow_arm64_scan_found_no_targets"}'
  exit 1
fi

HOOK_ARGS=()
for offset in "${TARGET_OFFSETS[@]}"; do
  HOOK_ARGS+=(--target-offset "$offset")
done

python3 scripts/arm64_wechat_key_hook.py \
  --pid "$PID" \
  --duration-sec "$DURATION_SEC" \
  --data-root "$DATA_ROOT" \
  "${HOOK_ARGS[@]}" \
  --struct-scan \
  --trace-hits 12 \
  --validate-on-hit \
  "${ACCOUNT_ARGS[@]}" \
  "${DB_LABEL_ARGS[@]}" \
  "${PAGE_SIZE_ARGS[@]}" \
  --candidates "$CANDIDATES_PATH" \
  --secrets "$SECRETS_PATH"

python3 scripts/validate_wechat_db_key.py \
  --data-root "$DATA_ROOT" \
  --candidates "$CANDIDATES_PATH" \
  --secrets "$SECRETS_PATH" \
  --fast-raw \
  "${ACCOUNT_ARGS[@]}" \
  "${DB_LABEL_ARGS[@]}" \
  "${PAGE_SIZE_ARGS[@]}" \
  --json
