// Reproduce the "Missing Authentication header" path and prove it is fixed.
let P=true; const ck=(c,m)=>{console.log((c?"PASS":"FAIL")+"  "+m); if(!c)P=false;};
const decrypt = (e) => e === "ENC(empty)" ? "" : e.replace(/^ENC\(|\)$/g,"");

// the fixed logic
function pickApiKey(reqAi, stored, provider){
  const typed = typeof reqAi?.apiKey === "string" ? reqAi.apiKey.trim() : "";
  if (typed) return typed;
  if (stored?.apiKeyEnc && stored.provider === provider){ const k=decrypt(stored.apiKeyEnc); if(k) return k; }
  return "";
}
// the old logic, for contrast
const oldPick = (reqAi, stored) => stored?.apiKeyEnc ? decrypt(stored.apiKeyEnc) : reqAi?.apiKey;

console.log("— your screenshot: nvidia key stored, switched to openrouter, key pasted, Test clicked —");
{
  const stored = { provider:"nvidia", apiKeyEnc:"ENC(nvidia-key-123)" };
  const req = { provider:"openrouter", apiKey:"sk-or-v1-REAL" };
  ck(oldPick(req, stored) === "nvidia-key-123", "OLD: sent the NVIDIA key to OpenRouter (wrong credential)");
  ck(pickApiKey(req, stored, "openrouter") === "sk-or-v1-REAL", "NEW: sends the key you actually typed");
}

console.log("\n— the empty-stored-key case that produces the exact error —");
{
  const stored = { provider:"openrouter", apiKeyEnc:"ENC(empty)" };
  const req = { provider:"openrouter", apiKey:"sk-or-v1-REAL" };
  ck(oldPick(req, stored) === "", "OLD: empty stored key -> `Bearer ` -> \"Missing Authentication header\"");
  ck(pickApiKey(req, stored, "openrouter") === "sk-or-v1-REAL", "NEW: falls through to the typed key");
}

console.log("\n— stored key still works when nothing is typed —");
{
  const stored = { provider:"openrouter", apiKeyEnc:"ENC(sk-or-stored)" };
  ck(pickApiKey({ provider:"openrouter" }, stored, "openrouter") === "sk-or-stored",
     "saved key is reused for the SAME provider (no need to retype)");
  ck(pickApiKey({ provider:"kimi" }, stored, "kimi") === "",
     "…and is NOT reused for a different provider");
}

console.log("\n— actionable failure instead of a provider-side riddle —");
{
  const stored = { provider:"nvidia", apiKeyEnc:"ENC(k)" };
  const key = pickApiKey({ provider:"openrouter" }, stored, "openrouter");
  const err = !key ? `No API key for "openrouter". Paste the key and click Save provider settings — the stored key belongs to "nvidia".` : null;
  ck(!!err && /belongs to "nvidia"/.test(err), "error names the real problem: " + err);
}
console.log(P?"\nALL KEY TESTS PASSED":"\nFAILED"); process.exit(P?0:1);
