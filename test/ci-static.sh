#!/usr/bin/env bash
# cs-myfree 静态自检 —— 不安装、不联网，纯结构校验。
# 用法：bash test/ci-static.sh   退出码 0 = 全过
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
FAIL=0
ok(){ printf '  ✅ %s\n' "$1"; }
no(){ printf '  ❌ %s\n' "$1"; FAIL=$((FAIL+1)); }

echo "[1] package.json 结构"
node -e '
const p=require("./package.json");
const need=[["name","cs-myfree"],["type","module"]];
for(const [k,v] of need) if(String(p[k])!==String(v)) {console.error("  ❌ "+k+"="+p[k]); process.exit(1)}
if(!p.dsh||!p.dsh.bundle||!p.dsh.bundle.patch){console.error("  ❌ 缺 dsh.bundle.patch");process.exit(1)}
console.log("  ✅ name/type/dsh.bundle.patch")
' || FAIL=$((FAIL+1))

echo "[2] 零第三方依赖"
node -e '
const p=require("./package.json");
const d=Object.keys(p.dependencies||{});
if(d.length){console.error("  ❌ 有依赖: "+d.join(","));process.exit(1)}
console.log("  ✅ dependencies 为空")
' || FAIL=$((FAIL+1))

echo "[3] exports 指向的文件都存在"
node -e '
const fs=require("fs"),path=require("path");
const p=require("./package.json");
let bad=[];
for(const [k,v] of Object.entries(p.exports||{})) if(!fs.existsSync(path.join(".",v))) bad.push(v);
if(bad.length){console.error("  ❌ 缺文件: "+bad.join(","));process.exit(1)}
console.log("  ✅ 全部存在")
' || FAIL=$((FAIL+1))

echo "[4] 所有 src/*.js 语法"
for f in src/*.js; do
  node --check "$f" 2>/dev/null && ok "语法 $f" || no "语法 $f"
done

echo "[5] patch 只 insert 自己（不得 insert 官方 id）"
if grep -qE "^-\s*insert:" cordis.patch.yml; then
  ok "有 insert 段"
else
  no "缺 insert 段"
fi
if grep -qE "name:\s*'@deepseek-ai/" cordis.patch.yml; then
  no "patch 里出现了官方包名（禁止）"
else
  ok "未引用官方包名"
fi

echo "[6] src 下不得出现第三方 import（只允许 node: 与相对路径）"
BAD=$(grep -rhoE "from ['\"][^'\"]+['\"]" src/*.js 2>/dev/null | sed -E "s/from ['\"]//;s/['\"]//" | grep -vE "^(node:|\./|\.\./)" | sort -u || true)
if [ -n "$BAD" ]; then no "发现外部 import: $(echo "$BAD" | tr '\n' ' ')"; else ok "无外部 import"; fi

echo "[7] 客户端半身格式（必须 __ModuleLoader__.load，不是裸 ESM）"
if [ -f src/client.js ]; then
  if head -20 src/client.js | grep -q "__ModuleLoader__"; then
    ok "client.js 使用 __ModuleLoader__.load"
  else
    no "client.js 不是 __ModuleLoader__.load 格式 ⇒ 设置页会静默不出现"
  fi
  if grep -q "exports.apply" src/client.js; then ok "导出 apply"; else no "缺 exports.apply"; fi
  if grep -q "exports.inject" src/client.js; then ok "导出 inject"; else no "缺 exports.inject"; fi
else
  no "缺 src/client.js"
fi

echo
if [ "$FAIL" -eq 0 ]; then echo "全部通过 ✅"; exit 0; else echo "失败 $FAIL 项 ❌"; exit 1; fi
