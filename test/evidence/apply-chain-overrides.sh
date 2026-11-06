#!/usr/bin/env bash
# 应用「禁用 buddy/qoder」到真实运行链（需在宿主用户下运行；本仓沙箱只能生成文件，不能写 ~/.dsh）
#
# 用法：bash apply-chain-overrides.sh [--dry-run]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${DSH_HOME:-$HOME/.dsh}/cs-myfree/chain-overrides.json"
SRC="$HERE/chain-overrides.proposed.json"

[ -f "$TARGET" ] || { echo "找不到 $TARGET"; exit 1; }
[ -f "$SRC" ] || { echo "找不到 $SRC"; exit 1; }

if [ "${1:-}" = "--dry-run" ]; then
  echo "将写入 $TARGET（内容来自 $SRC）："
  diff <(python3 -c 'import json,sys;print(json.dumps(json.load(open(sys.argv[1])),ensure_ascii=False,indent=2,sort_keys=True))' "$TARGET") \
       <(python3 -c 'import json,sys;print(json.dumps(json.load(open(sys.argv[1])),ensure_ascii=False,indent=2,sort_keys=True))' "$SRC") || true
  exit 0
fi

BAK="$TARGET.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$TARGET" "$BAK"
echo "已备份 → $BAK"
python3 - "$TARGET" "$SRC" <<'PY'
import json, sys
target, src = sys.argv[1], sys.argv[2]
cur = json.load(open(target, encoding='utf-8'))
new = json.load(open(src, encoding='utf-8'))
want = {e['provider']: e for e in new['chain'] if e.get('disabled') is True}
changed = 0
for e in cur['chain']:
    if e['provider'] in want and e.get('disabled') is not True:
        e['disabled'] = True
        changed += 1
cur['at'] = int(__import__('time').time() * 1000)
json.dump(cur, open(target, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
open(target, 'a', encoding='utf-8').write('\n')
print(f'已禁用 {changed} 条；当前链：')
for e in cur['chain']:
    print(' ', e['provider'], 'tier', e['tier'], 'disabled', e.get('disabled') is True)
PY
