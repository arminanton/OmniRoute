#!/usr/bin/env python3
"""
Personal Automated Email OTP Login Helper for MaxAI & UC Persona
-----------------------------------------------------------------
Uses local `codex` CLI with Gmail plugin to fetch the latest OTP
verification code received in Gmail, completing browserless authentication.

Private & Personal tool: NEVER commit credentials or push this file to public upstream.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional, Dict, Any

CODEX_PATH = os.environ.get("CODEX_PATH", "/home/ndsadmin/.local/bin/codex")
RESIDENTIAL_PROXY = os.environ.get("RESIDENTIAL_PROXY", "http://127.0.0.1:1055")

def fetch_otp_via_codex_gmail(provider: str, timeout_seconds: int = 45) -> Optional[str]:
    """
    Invokes `codex exec` with `gpt-5.6-luna` (reasoning medium) to search
    the user's Gmail for the newest OTP code received in the last 2 minutes.
    """
    search_query = "MaxAI" if provider.lower() == "maxai" else "uncensored.com OR Clerk OR UC"

    prompt = f"""
You are an automated authentication assistant with access to Gmail tools.
Search my Gmail inbox for the newest unread or recent email from '{search_query}' received in the last 2 minutes.
Extract ONLY the numerical verification code (OTP / passcode) from the email body or subject.
Return strictly a JSON object in this format:
{{"code": "123456", "sender": "...", "subject": "..."}}
Do not return any markdown code blocks or explanations, only valid JSON.
"""

    cmd = [
        CODEX_PATH,
        "exec",
        "-m", "gpt-5.6-luna",
        "-c", "model_reasoning_effort=medium",
        prompt.strip()
    ]

    env = os.environ.copy()
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_seconds,
            env=env
        )
        output = proc.stdout.strip()
        if proc.returncode != 0:
            print(f"[ERROR] Codex CLI failed (exit {proc.returncode}): {proc.stderr}", file=sys.stderr)
            return None

        # Parse JSON or regex extract 4-8 digits
        match_json = re.search(r'\{[^\}]*"code"\s*:\s*"([0-9]{4,8})"[^\}]*\}', output)
        if match_json:
            try:
                data = json.loads(match_json.group(0))
                return data.get("code")
            except Exception:
                return match_json.group(1)

        match_digits = re.search(r'\b([0-9]{5,8})\b', output)
        if match_digits:
            return match_digits.group(1)

        print(f"[WARN] No OTP code parsed from Codex output: {output}", file=sys.stderr)
        return None
    except subprocess.TimeoutExpired:
        print(f"[ERROR] Codex CLI timed out after {timeout_seconds}s", file=sys.stderr)
        return None
    except Exception as e:
        print(f"[ERROR] Error executing Codex CLI: {e}", file=sys.stderr)
        return None

def main():
    parser = argparse.ArgumentParser(description="Automated Email OTP Login via Codex Gmail Tool")
    parser.add_argument("--provider", choices=["maxai", "uc"], required=True, help="Provider to login")
    parser.add_argument("--email", help="Account email address")
    parser.add_argument("--test-fetch-only", action="store_true", help="Test fetching the latest OTP code from Gmail")
    args = parser.parse_args()

    if args.test_fetch_only:
        print(f"[*] Querying Gmail via Codex CLI for latest {args.provider.upper()} OTP...")
        code = fetch_otp_via_codex_gmail(args.provider)
        if code:
            print(f"[SUCCESS] Retrieved OTP Code: {code}")
            sys.exit(0)
        else:
            print("[FAILED] Could not retrieve OTP code.")
            sys.exit(1)

    print(f"[*] Provider email login automation for {args.provider.upper()} configured.")

if __name__ == "__main__":
    main()
