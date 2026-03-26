#!/usr/bin/env python3
"""Dispara lookup de contrato no cache local TOA bridge.

Uso: python3 src/toa_lookup.py 1234567
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

BOT_BUILD = os.getenv("BOT_BUILD", "v27")
HOST = os.getenv("TOA_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.getenv("TOA_BRIDGE_PORT", "8787"))
TOKEN = os.getenv("TOA_BRIDGE_TOKEN", "")
WAIT_SECONDS = float(os.getenv("TOA_PY_WAIT_SECONDS", "20"))
POLL_INTERVAL = float(os.getenv("TOA_PY_POLL_INTERVAL", "1"))


def fetch_contract(contract: str):
    url = f"http://{HOST}:{PORT}/toa/contract/{contract}"
    req = urllib.request.Request(url, method="GET")
    if TOKEN:
        req.add_header("x-toa-token", TOKEN)
    with urllib.request.urlopen(req, timeout=8) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        data = json.loads(body)
        if not isinstance(data, dict):
            return None
        return data


def main():
    if len(sys.argv) < 2:
        print(f"[{BOT_BUILD}] uso: toa_lookup.py <contrato>")
        return 2

    contract = ''.join(ch for ch in sys.argv[1] if ch.isdigit())
    if len(contract) < 6:
        print(f"[{BOT_BUILD}] contrato inválido: {sys.argv[1]}")
        return 2

    deadline = time.time() + WAIT_SECONDS
    while True:
        try:
            found = fetch_contract(contract)
            if found and found.get("contrato"):
                phones = found.get("telefones") or []
                print(f"[{BOT_BUILD}] contrato={contract} encontrado no TOA cache | telefones={len(phones)}")
                return 0
        except urllib.error.HTTPError as e:
            print(f"[{BOT_BUILD}] bridge HTTP {e.code} para contrato={contract}")
            return 1
        except Exception as e:  # noqa: BLE001
            if time.time() >= deadline:
                print(f"[{BOT_BUILD}] bridge indisponível/sem retorno: {e}")
                return 1

        if time.time() >= deadline:
            print(f"[{BOT_BUILD}] contrato={contract} ainda não apareceu no cache TOA (abra TOA, pesquise o contrato e mantenha a extensão ativa)")
            return 1
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    raise SystemExit(main())