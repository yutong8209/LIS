#!/usr/bin/env python3
"""Browser control script for iMedicalLIS.

输出契约：任何情况下都打印单行 JSON；失败统一为 {"success": false, "error": "..."}。
"""
import sys
import json
import base64
import io
from PIL import Image
import mss
import pyautogui


def fail(msg):
    """统一的错误返回（保持 JSON 契约，调用方只需看 success 字段）"""
    return {"success": False, "error": msg}


def take_screenshot():
    """Take a screenshot and return base64 encoded image."""
    try:
        with mss.MSS() as sct:
            monitor = sct.monitors[1]
            screenshot = sct.grab(monitor)
            img = Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")
            buffer = io.BytesIO()
            img.save(buffer, format="PNG")
            img_str = base64.b64encode(buffer.getvalue()).decode()
            return {"success": True, "image": img_str}
    except Exception as e:
        return fail(str(e))

def click(x, y):
    """Click at coordinates."""
    try:
        pyautogui.click(x, y)
        return {"success": True}
    except Exception as e:
        return fail(str(e))

def type_text(text):
    """Type text."""
    try:
        pyautogui.typewrite(text, interval=0.05)
        return {"success": True}
    except Exception as e:
        return fail(str(e))

def press_key(key):
    """Press a key."""
    try:
        pyautogui.press(key)
        return {"success": True}
    except Exception as e:
        return fail(str(e))

def main():
    """Main entry point."""
    if len(sys.argv) < 2:
        print(json.dumps(fail("No command specified")))
        return

    command = sys.argv[1]

    if command == "screenshot":
        print(json.dumps(take_screenshot()))
    elif command == "click":
        if len(sys.argv) < 4:
            print(json.dumps(fail("click requires x y coordinates")))
            return
        try:
            x, y = int(sys.argv[2]), int(sys.argv[3])
        except ValueError:
            print(json.dumps(fail(f"coordinates must be integers, got: {sys.argv[2]!r}, {sys.argv[3]!r}")))
            return
        print(json.dumps(click(x, y)))
    elif command == "type":
        if len(sys.argv) < 3:
            print(json.dumps(fail("type requires text argument")))
            return
        text = sys.argv[2]
        # typewrite 仅支持 ASCII；中文请走剪贴板粘贴（pbcopy + Cmd+V）
        if not text.isascii():
            print(json.dumps(fail("typewrite only supports ASCII; for Chinese use clipboard paste (pbcopy + Cmd+V)")))
            return
        print(json.dumps(type_text(text)))
    elif command == "key":
        if len(sys.argv) < 3:
            print(json.dumps(fail("key requires key argument")))
            return
        key = sys.argv[2]
        print(json.dumps(press_key(key)))
    else:
        print(json.dumps(fail(f"Unknown command: {command}")))

if __name__ == "__main__":
    main()
