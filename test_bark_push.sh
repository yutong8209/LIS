#!/bin/bash
# Bark 推送自测脚本
# 用法:
#   bash test_bark_push.sh          # 走本地 serve.py /notify 链路（推荐，测全链路）
#   bash test_bark_push.sh --direct # 直接调 Bark 云接口（只验证设备码本身）
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
CFG="$DIR/notify_config.json"

if [ ! -f "$CFG" ]; then
  echo "❌ 未找到 $CFG"
  echo "   先执行: cp $DIR/notify_config.example.json $CFG"
  echo "   然后把 bark_key 改成你的 Bark 设备码（iPhone 上 Bark App → 设置 → 设备 → 复制设备码）"
  exit 1
fi

KEY="$(python3 -c "import json;print(json.load(open('$CFG'))['bark_key'])" 2>/dev/null)"
ENABLED="$(python3 -c "import json;print(json.load(open('$CFG')).get('enabled',True))" 2>/dev/null)"
if [ -z "$KEY" ] || [ "$KEY" = "在此粘贴 Bark App 里的设备码" ]; then
  echo "❌ notify_config.json 里的 bark_key 还是占位文本，请改成真实设备码"
  exit 1
fi
if [ "$ENABLED" != "True" ]; then
  echo "⚠️  notify_config.json 的 enabled=false，推送已关闭——先改回 true"
fi

if [ "${1:-}" = "--direct" ]; then
  echo "→ 直连 Bark 云验证设备码（若配置了推送加密则自动加密）..."
  python3 - "$DIR" <<'PYEOF'
import json, os, sys
sys.path.insert(0, sys.argv[1])
os.chdir(sys.argv[1])
import urllib.request
import serve  # main guard 后仅复用函数，不启动服务

cfg = json.load(open('notify_config.json'))
key = cfg['bark_key'].strip()
payload = {'device_key': key, 'title': '🧪 Bark 直连测试',
           'body': '设备码有效，链路可达', 'level': 'active'}
enc_note = ''
try:
    enc = serve._load_encrypt_cfg(cfg)
    if enc:
        ek, fixed_iv = enc
        inner = json.dumps({'title': payload['title'], 'body': payload['body']}, ensure_ascii=False)
        import base64, secrets, string
        iv = fixed_iv or ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(16))
        payload = {'device_key': key, 'level': 'active',
                   'ciphertext': base64.b64encode(serve.aes_cbc_encrypt(inner.encode(), ek, str(iv).encode())).decode(),
                   'iv': iv}
        enc_note = '[已加密]'
except Exception as e:
    print(f'❌ 加密配置无效（fail-closed，不发送）: {e}')
    sys.exit(1)

req = urllib.request.Request('https://api.day.app/push',
                             data=json.dumps(payload).encode(),
                             headers={'Content-Type': 'application/json'})
print(urllib.request.urlopen(req, timeout=10).read().decode())
print(f'✅ 已直连 Bark 云{enc_note}，手机上应收到「🧪 Bark 直连测试」')
PYEOF
else
  echo "→ 走本地 serve.py /notify（需 serve.py 在运行）..."
  RESP="$(curl -s -m 10 -X POST "http://127.0.0.1:8765/notify" \
    -H 'Content-Type: text/plain' \
    -d "{\"title\":\"🧪 Bark 测试\",\"body\":\"自动审核推送链路正常\",\"level\":\"active\"}")"
  echo "本地响应: $RESP"
  if echo "$RESP" | grep -q '"accepted": true'; then
    echo "✅ 已提交给 Bark 云转发，手机上应已收到「🧪 Bark 测试」"
  else
    echo "⚠️ 未被接受（多半是 serve.py 未运行或配置未生效），见上"
  fi
fi