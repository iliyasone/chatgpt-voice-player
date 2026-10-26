# Privacy

ChatGPT Voice Player runs only on `https://chatgpt.com`.

- It sends requests only to chatgpt.com, using your existing signed-in session: `/api/auth/session`
  (access token), `/backend-api/settings/voices` (your selected voice) and
  `/backend-api/synthesize` (the audio of a reply).
- Audio stays in the tab's memory and is discarded when the tab closes or navigates away from the
  conversation.
- It stores, via `chrome.storage`, only its settings (voice, speed, load in advance) and the list of
  voice names ChatGPT offers.
- No analytics, no third-party servers, no data collection.
