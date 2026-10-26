#!/bin/sh
# Builds dist/chatgpt-voice-player.zip: the contents of extension/, ready for Load unpacked or the Web Store.
set -e
cd "$(dirname "$0")/.."
mkdir -p dist
rm -f dist/chatgpt-voice-player.zip
(cd extension && python3 -m zipfile -c ../dist/chatgpt-voice-player.zip *)
echo dist/chatgpt-voice-player.zip
