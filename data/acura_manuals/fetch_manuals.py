#!/usr/bin/env python3
"""Download Acura owner's manual PDFs for a given model year.

No login needed. mygarage.honda.com is a Salesforce Experience Cloud site whose
guest (unauthenticated) Aura endpoint exposes two Apex calls the site's own UI uses:

  FindProductController.getProductChooserData({division})
      -> every year/model/trim row, each with a Product_Model_ID__c
  OwnManualsApiController.getManualByModelIdAuto({divisionId, division, modelId})
      -> manual title + URL for that model id

Many trims share one manual, so PDFs are deduped by URL.

Usage:
  python3 fetch_manuals.py --year 2025 --out manuals_2025
  python3 fetch_manuals.py --year 2025 --list-only     # write manifest, no PDFs
  python3 fetch_manuals.py --years 2026 2027 --root staging   # staging/manuals_2026, staging/manuals_2027
  python3 fetch_manuals.py --years 2026 --known known.json    # skip PDFs whose server headers match
  python3 fetch_manuals.py --year 2026 --links-only    # no network: rebuild by_trim/ and MAPPING.txt

Each run also writes downloads.json next to manifest.csv: per PDF, whether it
was downloaded, kept (already on disk), unchanged (its Content-Length and
Last-Modified match --known, so it wasn't downloaded) or failed, with those
headers. `npm run manuals:check` (scripts/manuals/update.ts) reads it.
"""
import argparse
import csv
import json
import os
import re
import shutil
import ssl
import sys
import time
from pathlib import Path
from urllib.parse import unquote

import certifi
import requests

BASE = "https://mygarage.honda.com"
AURA_URL = f"{BASE}/s/sfsites/aura"
# techinfo.honda.com serves the wrong intermediate cert (browsers repair this by
# following the cert's AIA link; Python doesn't). Fetch the right one and trust it
# only as an extra intermediate: the chain must still validate up to a certifi root.
INTERMEDIATE_URL = "http://cacerts.digicert.com/DigiCertEVRSACAG2.crt"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36"


def ca_bundle(path):
    if not path.exists():
        der = requests.get(INTERMEDIATE_URL, timeout=30).content
        pem = ssl.DER_cert_to_PEM_cert(der)
        path.write_text(Path(certifi.where()).read_text() + "\n" + pem)
    return str(path)


def safe(name):
    return re.sub(r'[\\/:*?"<>|]', "-", name).strip()


def link_by_trim(out, manifest):
    """Build by_trim/<model>/<trim>/<title>.pdf for every trim.

    Hard links, so a manual shared by many trims is stored once on disk.
    """
    root = out / "by_trim"
    shutil.rmtree(root, ignore_errors=True)
    for m in manifest:
        src = out / "raw" / m["url"].rsplit("/", 1)[-1]
        if not src.exists():
            continue
        dest = root / safe(m["model"]) / safe(m["trim"]) / f"{safe(m['title'])}.pdf"
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(src, dest)
        except OSError:
            shutil.copy2(src, dest)
        m["file"] = str(dest.relative_to(out))


def write_mapping(out, manifest, year):
    """Human-readable PDF -> trims map, one block per unique PDF (ingest each once)."""
    groups = {}
    for m in manifest:
        name = m["url"].rsplit("/", 1)[-1]
        if name.upper().endswith(".PDF"):
            groups.setdefault(name, {"title": m["title"], "model": m["model"], "trims": []})["trims"].append(m["trim"])
    lines = [
        f"{year} Acura manuals: PDF -> model/trims",
        f"{len(groups)} unique PDFs cover {len({(m['model'], m['trim']) for m in manifest})} model/trim combinations.",
        "Ingest each PDF once; every trim listed under it uses that same file.",
        "",
    ]
    for name, g in sorted(groups.items(), key=lambda kv: (kv[1]["model"], kv[1]["title"])):
        size = out / "raw" / name
        mb = f" ({size.stat().st_size / 1e6:.1f} MB)" if size.exists() else ""
        lines += [f"{name}{mb}", f"  {g['title']}"]
        lines += [f"    - {t}" for t in g["trims"]]
        lines.append("")
    (out / "MAPPING.txt").write_text("\n".join(lines))


def bootstrap(session):
    """Scrape the Aura framework uid and app version from the public page."""
    html = session.get(f"{BASE}/s/find-acura", timeout=30).text
    html = unquote(html)
    fwuid = re.search(r'"fwuid":"([^"]+)"', html)
    app = re.search(r'"APPLICATION@markup://siteforce:communityApp":"([^"]+)"', html)
    if not (fwuid and app):
        sys.exit("Could not find fwuid/app version in page; the site may have changed.")
    return fwuid.group(1), app.group(1)


class Aura:
    def __init__(self, session):
        self.s = session
        self.fwuid, self.app_ver = bootstrap(session)
        self.n = 0

    def apex(self, classname, method, params=None, retries=3):
        action = {
            "id": "1;a",
            "descriptor": "aura://ApexActionController/ACTION$execute",
            "callingDescriptor": "UNKNOWN",
            "params": {
                "namespace": "",
                "classname": classname,
                "method": method,
                "params": params or {},
                "cacheable": False,
                "isContinuation": False,
            },
        }
        context = {
            "mode": "PROD",
            "fwuid": self.fwuid,
            "app": "siteforce:communityApp",
            "loaded": {"APPLICATION@markup://siteforce:communityApp": self.app_ver},
            "dn": [],
            "globals": {},
            "uad": True,
        }
        data = {
            "message": json.dumps({"actions": [action]}),
            "aura.context": json.dumps(context),
            "aura.pageURI": "/s/find-acura",
            "aura.token": "null",
        }
        for attempt in range(retries):
            self.n += 1
            r = self.s.post(f"{AURA_URL}?r={self.n}&aura.ApexAction.execute=1", data=data, timeout=60)
            if r.ok:
                act = r.json()["actions"][0]
                if act["state"] == "SUCCESS":
                    return act["returnValue"]["returnValue"]
                err = act.get("error")
            else:
                err = r.status_code
            time.sleep(2 * (attempt + 1))
        raise RuntimeError(f"{classname}.{method} failed: {err}")


def read_manifest(out):
    with open(out / "manifest.csv", newline="") as f:
        return list(csv.DictReader(f))


def write_manifest(out, manifest):
    with open(out / "manifest.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["year", "model", "trim", "model_id", "title", "file", "url"], restval="")
        w.writeheader()
        w.writerows(manifest)


def server_headers(r):
    size = r.headers.get("Content-Length")
    return {"size": int(size) if size and size.isdigit() else None, "last_modified": r.headers.get("Last-Modified")}


def unchanged_on_server(s, url, verify, known):
    """True when the server's Content-Length and Last-Modified match the known ones (both must be present)"""
    if not (known and known.get("size") and known.get("last_modified")):
        return False, None
    try:
        r = s.head(url, timeout=60, verify=verify, allow_redirects=True)
    except requests.RequestException:
        return False, None
    if not r.ok:
        return False, None
    headers = server_headers(r)
    return headers["size"] == known["size"] and headers["last_modified"] == known["last_modified"], headers


def download(s, pdfs, out, verify, known, delay):
    """Download the PDFs into out/raw; returns {file name: {status, size, last_modified[, error]}}"""
    (out / "raw").mkdir(exist_ok=True)
    results = {}
    for u in pdfs:
        name = u.rsplit("/", 1)[-1]
        dest = out / "raw" / name
        if dest.exists() and dest.stat().st_size > 0:
            results[name] = {"status": "kept", "size": None, "last_modified": None}
            continue
        same, headers = unchanged_on_server(s, u, verify, known.get(name))
        if same:
            results[name] = {"status": "unchanged", **headers}
            print(f"  unchanged {name}")
            time.sleep(delay)
            continue
        try:
            r = s.get(u, timeout=120, verify=verify)
            ok = r.ok and r.content[:4] == b"%PDF"
            error = None if ok else f"HTTP {r.status_code}" if not r.ok else "not a PDF"
        except requests.RequestException as e:
            ok, error = False, str(e)
        if ok:
            dest.write_bytes(r.content)
            headers = server_headers(r)
            results[name] = {"status": "downloaded", "size": headers["size"] or len(r.content),
                             "last_modified": headers["last_modified"]}
            print(f"  saved {dest.name} ({len(r.content) // 1024} KB)")
        else:
            results[name] = {"status": "failed", "size": None, "last_modified": None, "error": error}
            print(f"  FAILED {u} ({error})")
        time.sleep(delay)
    return results


def fetch_year(aura, s, verify, all_rows, year, out, args, known):
    out.mkdir(parents=True, exist_ok=True)
    rows = [r for r in all_rows if r.get("Tier1__c") == year]
    print(f"{len(rows)} {year} {args.division} year/model/trim rows")

    manifest = []
    for r in rows:
        model_id = (r.get("Product_Model__r") or {}).get("Product_Model_ID__c")
        res = aura.apex(
            "OwnManualsApiController",
            "getManualByModelIdAuto",
            {"divisionId": args.division_id, "division": args.division, "modelId": model_id},
        )
        manuals = (res or {}).get("manualsList") or []
        if not manuals:
            print(f"  no manual: {r['Tier2__c']} / {r['Tier3__c']} ({model_id})")
        for m in manuals:
            manifest.append({
                "year": r["Tier1__c"], "model": r["Tier2__c"], "trim": r["Tier3__c"],
                "model_id": model_id, "title": m["title"],
                "url": m["url"].replace("http://", "https://"),
            })
        time.sleep(args.delay)

    write_manifest(out, manifest)
    write_mapping(out, manifest, year)
    urls = sorted({m["url"] for m in manifest})
    pdfs = [u for u in urls if u.upper().endswith(".PDF")]
    print(f"manifest.csv written: {len(manifest)} rows, {len(urls)} unique URLs, {len(pdfs)} PDFs")
    print("(the 'Interactive Owner's Manual' entries are HTML, not PDFs, and are skipped)")

    if args.list_only:
        return

    results = download(s, pdfs, out, verify, known, args.delay)
    (out / "downloads.json").write_text(json.dumps(results, indent=2))

    link_by_trim(out, manifest)
    write_manifest(out, manifest)
    write_mapping(out, manifest, year)
    print(f"by_trim/ written under {out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default=None, help="one model year (default 2025)")
    ap.add_argument("--years", nargs="+", help="several model years, each in <root>/manuals_<year>")
    ap.add_argument("--root", default=".", help="with --years: the folder that holds the manuals_<year> folders")
    ap.add_argument("--division", default="Acura")
    ap.add_argument("--division-id", default="B", help="B = Acura, A = Honda")
    ap.add_argument("--out", default=None, help="output dir (default: manuals_<year>)")
    ap.add_argument("--delay", type=float, default=1.0, help="seconds between requests")
    ap.add_argument("--list-only", action="store_true", help="write manifest only, skip PDF downloads")
    ap.add_argument("--known", default=None,
                    help="JSON of {file name: {size, last_modified}}: PDFs whose server headers still match aren't downloaded")
    ap.add_argument("--links-only", action="store_true",
                    help="no network: rebuild by_trim/, MAPPING.txt and manifest.csv's file column from manifest.csv and raw/")
    args = ap.parse_args()

    if args.years:
        if args.out:
            sys.exit("--out is for --year; use --root with --years")
        targets = [(y, Path(args.root) / f"manuals_{y}") for y in args.years]
    else:
        year = args.year or "2025"
        targets = [(year, Path(args.out or f"manuals_{year}"))]

    if args.links_only:
        for year, out in targets:
            manifest = read_manifest(out)
            link_by_trim(out, manifest)
            write_manifest(out, manifest)
            write_mapping(out, manifest, year)
            print(f"by_trim/ and MAPPING.txt rebuilt under {out}")
        return

    known = json.loads(Path(args.known).read_text()) if args.known else {}

    s = requests.Session()
    s.headers["User-Agent"] = UA
    aura = Aura(s)
    pdf_verify = ca_bundle(Path(__file__).with_name("ca_bundle.pem"))

    all_rows = aura.apex("FindProductController", "getProductChooserData", {"division": args.division})
    for year, out in targets:
        fetch_year(aura, s, pdf_verify, all_rows, year, out, args, known)


if __name__ == "__main__":
    main()
