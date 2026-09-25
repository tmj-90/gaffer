#!/usr/bin/env bash
# Re-vendor the dashboard's web fonts (latin subsets) into
# packages/dispatch/src/api/web/assets/fonts/ and regenerate fonts.css, so the
# local-first dashboard makes NO third-party request on load. Run when bumping
# weights/families. Both families are SIL OFL 1.1 (see THIRD_PARTY_NOTICES.md).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../packages/dispatch/src/api/web/assets/fonts"; mkdir -p "$OUT"
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
URL="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap"
curl -sSf -A "$UA" "$URL" | OUT="$OUT" python3 -c '
import os,re,sys,subprocess
css=sys.stdin.read(); out=os.environ["OUT"]; faces=[]
for subset,body in re.findall(r"/\* (\w[\w-]*) \*/\s*@font-face \{(.*?)\}", css, re.S):
    if subset!="latin": continue
    fam=re.search(r"font-family: .([^;]+?).;", body).group(1); w=re.search(r"font-weight: (\d+)", body).group(1)
    url=re.search(r"url\((https://[^)]+\.woff2)\)", body).group(1); rng=re.search(r"unicode-range: ([^;]+);", body).group(1)
    fn=f"{fam.replace(chr(32),chr(0))}".replace(chr(0),"")+f"-{w}.woff2"
    subprocess.run(["curl","-sSf","-o",f"{out}/{fn}",url],check=True)
    faces.append(f"@font-face {{\n  font-family: \x27{fam}\x27;\n  font-style: normal;\n  font-weight: {w};\n  font-display: swap;\n  src: url(\x27/assets/fonts/{fn}\x27) format(\x27woff2\x27);\n  unicode-range: {rng};\n}}")
open(f"{out}/fonts.css","w").write("/* Self-hosted web fonts (latin subsets) — vendored so the local-first dashboard makes NO\n   third-party request on load. Space Grotesk and JetBrains Mono, both SIL Open Font\n   License 1.1 (see THIRD_PARTY_NOTICES.md). Regenerate with scripts/vendor-fonts.sh. */\n"+"\n".join(faces)+"\n")
print("vendored", len(faces), "faces into", out)'
