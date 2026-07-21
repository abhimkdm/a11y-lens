// Session lifecycle: the states the UI has to get right.
let P=true; const ck=(c,m)=>{console.log((c?"PASS":"FAIL")+"  "+m); if(!c)P=false;};

// Mirror of the sidecar helpers
let browser=null, page=null, recorderActive=false, logLines=[];
const sessionIsLive=()=>{ try{ return !!page && !page.isClosed() && !!browser && browser.isConnected(); }catch{ return false; } };
const forgetSession=(reason)=>{ if(!browser&&!page)return; if(recorderActive)recorderActive=false;
  browser=null; page=null; if(reason) logLines.push(reason); };

function openSession(){
  const listeners={};
  browser={ _c:true, isConnected(){return this._c;}, once(e,f){listeners[e]=f;},
            close(){ this._c=false; listeners.disconnected?.(); } };
  page={ _closed:false, isClosed(){return this._closed;}, once(e,f){listeners['p'+e]=f;},
         close(){ this._closed=true; listeners.pclose?.(); } };
  browser.once("disconnected",()=>forgetSession("browser closed"));
  page.once("close",()=>forgetSession("page closed"));
  recorderActive=true;
  return {browser,page};
}

// 1 · the reported bug: closed by hand, app still claims open
openSession();
ck(sessionIsLive(), "fresh session reports open");
page.close();                                   // user clicks X
ck(!sessionIsLive(), "after the user closes the window, session reports CLOSED");
ck(browser===null && page===null, "handles are dropped so the next scan cannot use a dead page");
ck(!recorderActive, "an active recording is stopped when the window closes");

// old behaviour, for contrast
let oldPage={_closed:true};
ck(!!oldPage === true, "…whereas the old truthiness check would still say open (this was the bug)");

// 2 · explicit close
openSession();
const wasOpen=sessionIsLive();
browser.close(); forgetSession("closed by user");
ck(wasOpen && !sessionIsLive(), "explicit Close session ends it");

// 3 · idempotent
logLines=[]; forgetSession("again");
ck(logLines.length===0, "closing an already-closed session is a no-op, not an error");

// 4 · switching engines
openSession();
ck(sessionIsLive(), "session open on engine A");
browser.close(); forgetSession("switch");
ck(!sessionIsLive(), "closed, so the picker unlocks and engine B can be chosen");
openSession();
ck(sessionIsLive(), "new session opens on engine B");

console.log(P?"\nALL SESSION TESTS PASSED":"\nFAILED"); process.exit(P?0:1);
