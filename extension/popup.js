const KNOWN_VOICES = [
  { id: "glimmer", name: "Sol" },
  { id: "fathom", name: "Arbor" },
  { id: "orbit", name: "Spruce" },
  { id: "breeze", name: "Breeze" },
  { id: "cove", name: "Cove" },
  { id: "ember", name: "Ember" },
  { id: "juniper", name: "Juniper" },
  { id: "maple", name: "Maple" },
  { id: "vale", name: "Vale" },
];
const RATES = [1, 1.25, 1.5, 1.75, 2];

const voiceSelect = document.getElementById("voice");
const rateSelect = document.getElementById("rate");

Promise.all([
  chrome.storage.sync.get({ voice: "", rate: 1 }),
  chrome.storage.local.get({ voices: [], accountVoice: "" }),
]).then(([sync, local]) => {
  // The content script saves the account's own voice list once it has talked to ChatGPT.
  const voices = local.voices.length ? local.voices : KNOWN_VOICES;
  if (sync.voice && !voices.some((v) => v.id === sync.voice)) voices.push({ id: sync.voice, name: sync.voice });
  const account = voices.find((v) => v.id === local.accountVoice);
  voiceSelect.add(new Option(`Same as in ChatGPT${account ? ` (${account.name})` : ""}`, ""));
  for (const v of voices) voiceSelect.add(new Option(v.name, v.id));
  voiceSelect.value = sync.voice;

  for (const r of RATES) rateSelect.add(new Option(r + "×", r));
  rateSelect.value = sync.rate;
});

voiceSelect.onchange = () => chrome.storage.sync.set({ voice: voiceSelect.value });
rateSelect.onchange = () => chrome.storage.sync.set({ rate: +rateSelect.value });
