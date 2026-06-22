#!/usr/bin/env python3
"""Browser control script for iMedicalLIS."""
import sys
import json
import base64
import io
import time
from PIL import Image
import mss
import pyautogui



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
        return {"success": False, "error": str(e)}

def click(x, y):
    """Click at coordinates."""
    try:
        pyautogui.click(x, y)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}

def type_text(text):
    """Type text."""
    try:
        pyautogui.typewrite(text, interval=0.05)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}

def press_key(key):
    """Press a key."""
    try:
        pyautogui.press(key)
        return {"success": True}
    except Exception as e:
        return {"success": False, "error": str(e)}

def main():
    """Main entry point."""
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command specified"}))
        return

    command = sys.argv[1]

    if command == "screenshot":
        print(json.dumps(take_screenshot()))
    elif command == "click":
        if len(sys.argv) < 4:
            print(json.dumps({"error": "click requires x y coordinates"}))
            return
        x, y = int(sys.argv[2]), int(sys.argv[3])
        print(json.dumps(click(x, y)))
    elif command == "type":
        if len(sys.argv) < 3:
            print(json.dumps({"error": "type requires text argument"}))
            return
        text = sys.argv[2]
        print(json.dumps(type_text(text)))
    elif command == "key":
        if len(sys.argv) < 3:
            print(json.dumps({"error": "key requires key argument"}))
            return
        key = sys.argv[2]
        print(json.dumps(press_key(key)))
    else:
        print(json.dumps({"error": f"Unknown command: {command}"}))

if __name__ == "__main__":
    main()
