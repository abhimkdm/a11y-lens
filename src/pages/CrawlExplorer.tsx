import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Paper, Typography, Stack, Button, TextField, MenuItem, Checkbox, Chip, Box,
  Alert, LinearProgress, IconButton, Tooltip, Collapse, Divider, ToggleButton,
  ToggleButtonGroup, InputAdornment, FormControlLabel,
} from "@mui/material";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import SearchIcon from "@mui/icons-material/Search";
import RefreshIcon from "@mui/icons-material/Refresh";
import DownloadIcon from "@mui/icons-material/Download";
import UploadIcon from "@mui/icons-material/Upload";
import DeleteIcon from "@mui/icons-material/DeleteOutline";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import SendIcon from "@mui/icons-material/Send";
import OpenInBrowserIcon from "@mui/icons-material/OpenInBrowser";
import { useNavigate } from "react-router-dom";
import { api } from "../services/api";
import { useAppStore } from "../store/useAppStore";

interface CrawlUrl {
  url: string;
  parent_url: string | null;
  depth: number;
  title: string | null;
  status_code: number | null;
  enabled: boolean;
  last_scanned: string | null;
  last_score: number | null;
}
interface CrawlSummary {
  id: number; name: string; root_url: string; source: string;
  created_at: string; urlCount: number; enabledCount: number;
}

// Build the parent→children index once, rather than filtering the whole list at
// every node. On a 500-page sitemap the naive version is visibly slow.
function buildTree(urls: CrawlUrl[]) {
  const byParent = new Map<string | null, CrawlUrl[]>();
  const known = new Set(urls.map((u) => u.url));
  for (const u of urls) {
    // A URL whose parent wasn't captured would otherwise vanish from the tree
    // entirely — attach it at the root rather than lose it.
    const key = u.parent_url && known.has(u.parent_url) ? u.parent_url : null;
    const list = byParent.get(key) ?? [];
    list.push(u);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.url.localeCompare(b.url));
  return byParent;
}

function shortLabel(u: CrawlUrl) {
  try {
    const p = new URL(u.url).pathname;
    return p === "/" ? "/" : p.split("/").filter(Boolean).slice(-1)[0] || p;
  } catch {
    return u.url;
  }
}

export default function CrawlExplorer() {
  const nav = useNavigate();
  const { setPendingUrlList, sessionOpen, setSessionOpen } = useAppStore();

  const [crawls, setCrawls] = useState<CrawlSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [urls, setUrls] = useState<CrawlUrl[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled" | "errors">("all");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // New crawl form
  const [source, setSource] = useState<"crawl" | "sitemap" | "list">("crawl");
  const [seed, setSeed] = useState("https://");
  const [maxPages, setMaxPages] = useState(100);
  const [maxDepth, setMaxDepth] = useState(3);
  const [listText, setListText] = useState("");
  // Keep the crawl inside the app area: stay under the root's path section and
  // ignore global header/nav/footer links. Both default on — that's what keeps
  // a /ecare crawl from wandering out into the marketing site.
  const [confinePath, setConfinePath] = useState(true);
  const [skipChrome, setSkipChrome] = useState(true);
  // Optional explicit section URLs, one per line — guaranteed starting points so
  // discovery doesn't depend on finding a link to each section.
  const [seedUrlsText, setSeedUrlsText] = useState("");

  const [status, setStatus] = useState<{ running: boolean; discovered: number; currentUrl: string | null; log: { msg: string }[] } | null>(null);
  const pollRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [sessionBusy, setSessionBusy] = useState(false);

  const refreshCrawls = useCallback(() => {
    api.crawlList().then((r) => r.ok && setCrawls(r.crawls)).catch(() => {});
  }, []);

  // Keep the shared session flag honest when landing on this page directly —
  // a session opened earlier (here or in Scan Center) should already unlock Discover.
  useEffect(() => {
    api.status().then((r) => setSessionOpen(!!r?.open)).catch(() => {});
  }, [setSessionOpen]);

  // Open a real Chrome window pointed at the root URL so the user can log in by
  // hand. The crawl then runs INSIDE that authenticated session. Uses the exact
  // same session machinery as Scan Center, so a session opened here is the same
  // one Scan Center sees, and vice-versa.
  // Mirror the backend's confinement math so the UI can show the user exactly
  // which path prefix a crawl will be limited to.
  const seedPathHint = (() => {
    try {
      const segs = new URL(seed).pathname.replace(/\/+$/, "").split("/").filter(Boolean);
      const prefix = segs.length ? `/${(segs.length > 1 ? segs.slice(0, 1) : segs).join("/")}/` : "/";
      return prefix === "/" ? "" : ` Staying within ${prefix}`;
    } catch { return ""; }
  })();

  const startSession = async () => {
    setError(""); setNotice("");
    const target = seed && /^https?:\/\/\S+/.test(seed) ? seed : undefined;
    setSessionBusy(true);
    const r = await api.openSession(target).catch((e) => ({ ok: false, error: String(e) }));
    setSessionBusy(false);
    if (!r.ok) { setError(r.error ?? "Could not start a browser session. Is the sidecar running?"); return; }
    setSessionOpen(true);
    setNotice(target
      ? "Chrome session started. Log in if needed, navigate to where you want discovery to begin, then click Discover."
      : "Chrome session started. Enter a Root URL above (or navigate in Chrome), then click Discover.");
  };

  const loadCrawl = useCallback((id: number) => {
    api.crawlGet(id).then((r) => {
      if (!r.ok) return;
      setSelectedId(id);
      setUrls(r.crawl.urls);
      // Open the first two levels: enough to see the shape, not so much that a
      // 500-page site dumps everything at once.
      setExpanded(new Set(r.crawl.urls.filter((u: CrawlUrl) => u.depth < 1).map((u: CrawlUrl) => u.url)));
    }).catch(() => {});
  }, []);

  useEffect(() => { refreshCrawls(); }, [refreshCrawls]);

  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  useEffect(() => stopPolling, []);

  const startCrawl = async () => {
    setError(""); setNotice("");
    const opts: Parameters<typeof api.crawlStart>[0] =
      source === "list"
        ? { source, urls: listText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean), name: "URL list" }
        : source === "sitemap"
        ? { source, sitemapUrl: seed, maxPages }
        : { source, rootUrl: seed, maxPages, maxDepth, confinePath, skipChrome,
            seedUrls: seedUrlsText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) };

    const r = await api.crawlStart(opts).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { setError(r.error ?? "Could not start the crawl"); return; }
    if (!r.usingSession) {
      setNotice("The browser session doesn't seem active anymore (was Chrome closed?). Pages behind a login may be missed. Click Start Session again if needed.");
    }

    pollRef.current = window.setInterval(async () => {
      const st = await api.crawlStatus().catch(() => null);
      if (!st?.ok) return;
      setStatus(st);
      if (!st.running) {
        stopPolling();
        setStatus(null);
        refreshCrawls();
        if (st.crawlId) loadCrawl(st.crawlId);
        if (st.error) setError(st.error);
      }
    }, 1000);
  };

  const tree = useMemo(() => buildTree(urls), [urls]);

  const matches = useCallback(
    (u: CrawlUrl) => {
      if (query && !(`${u.url} ${u.title ?? ""}`.toLowerCase().includes(query.toLowerCase()))) return false;
      if (filter === "enabled" && !u.enabled) return false;
      if (filter === "disabled" && u.enabled) return false;
      if (filter === "errors" && !(u.status_code && u.status_code >= 400)) return false;
      return true;
    },
    [query, filter]
  );

  // A node stays visible if it matches OR any descendant does — otherwise
  // filtering would hide the parents you need in order to reach a match.
  const visible = useMemo(() => {
    const keep = new Set<string>();
    const walk = (u: CrawlUrl): boolean => {
      const kids = tree.get(u.url) ?? [];
      const kidVisible = kids.map(walk).some(Boolean);
      const self = matches(u);
      if (self || kidVisible) { keep.add(u.url); return true; }
      return false;
    };
    (tree.get(null) ?? []).forEach(walk);
    return keep;
  }, [tree, matches]);

  const descendants = useCallback((url: string): string[] => {
    const out: string[] = [];
    const walk = (u: string) => {
      for (const c of tree.get(u) ?? []) { out.push(c.url); walk(c.url); }
    };
    walk(url);
    return out;
  }, [tree]);

  const setEnabled = async (targets: string[], enabled: boolean) => {
    if (!selectedId || !targets.length) return;
    setUrls((prev) => prev.map((u) => (targets.includes(u.url) ? { ...u, enabled } : u)));
    await api.crawlSetEnabled(selectedId, targets, enabled).catch(() => {});
    refreshCrawls();
  };

  const toggleNode = (u: CrawlUrl, withChildren: boolean) => {
    const targets = withChildren ? [u.url, ...descendants(u.url)] : [u.url];
    setEnabled(targets, !u.enabled);
  };

  const enabledUrls = urls.filter((u) => u.enabled).map((u) => u.url);

  const sendToScan = () => {
    if (!enabledUrls.length) { setError("No pages are enabled."); return; }
    setPendingUrlList(enabledUrls);
    nav("/scan");
  };

  const exportConfig = async () => {
    if (!selectedId) return;
    const r = await api.crawlExport(selectedId).catch(() => null);
    if (!r?.ok) { setError("Export failed."); return; }
    const blob = new Blob([JSON.stringify(r.config, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `a11y-crawl_${(r.config.name || "crawl").replace(/\W+/g, "-")}.json`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  };

  const importConfig = async (file: File) => {
    setError(""); setNotice("");
    try {
      const cfg = JSON.parse(await file.text());
      const r = await api.crawlImport(cfg);
      if (!r.ok) throw new Error(r.error);
      refreshCrawls();
      loadCrawl(r.crawlId);
      setNotice(`Imported ${r.imported} URLs.`);
    } catch (e) {
      setError(`Import failed: ${String((e as Error).message ?? e)}`);
    }
  };

  const renderNode = (u: CrawlUrl, level: number): React.ReactNode => {
    if (!visible.has(u.url)) return null;
    const kids = (tree.get(u.url) ?? []).filter((k) => visible.has(k.url));
    const isOpen = expanded.has(u.url);
    const kidUrls = descendants(u.url);
    const enabledKids = kidUrls.filter((k) => urls.find((x) => x.url === k)?.enabled).length;
    const indeterminate = kidUrls.length > 0 && enabledKids > 0 && enabledKids < kidUrls.length;

    return (
      <Box key={u.url}>
        <Stack direction="row" spacing={0.5} alignItems="center"
               sx={{ pl: level * 2.5, py: 0.25, borderRadius: 1,
                     "&:hover": { bgcolor: "rgba(138,199,255,0.06)" } }}>
          <IconButton size="small" sx={{ visibility: kids.length ? "visible" : "hidden" }}
            aria-label={isOpen ? "Collapse" : "Expand"}
            onClick={() => {
              const next = new Set(expanded);
              isOpen ? next.delete(u.url) : next.add(u.url);
              setExpanded(next);
            }}>
            {isOpen ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
          </IconButton>

          <Tooltip title={kidUrls.length ? "Click toggles this page. Shift-click also toggles all pages beneath it." : ""}>
            <Checkbox size="small" checked={u.enabled} indeterminate={!u.enabled && indeterminate}
              inputProps={{ "aria-label": `Enable ${u.url} for scanning` }}
              onClick={(e) => { e.preventDefault(); toggleNode(u, (e as React.MouseEvent).shiftKey); }}
              readOnly />
          </Tooltip>

          <Stack sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="body2" noWrap
                        sx={{ fontWeight: u.depth === 0 ? 600 : 400,
                              color: u.enabled ? "text.primary" : "text.secondary" }}>
              {u.title || shortLabel(u)}
            </Typography>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ fontFamily: "monospace", fontSize: 11 }}>
              {u.url}
            </Typography>
          </Stack>

          {u.status_code && u.status_code >= 400 && (
            <Chip size="small" color="error" variant="outlined" label={u.status_code} sx={{ height: 20, fontSize: 10.5 }} />
          )}
          {u.last_score != null && (
            <Chip size="small" variant="outlined" label={`${u.last_score}/100`} sx={{ height: 20, fontSize: 10.5 }} />
          )}
          {kids.length > 0 && (
            <Chip size="small" variant="outlined" label={kidUrls.length} sx={{ height: 20, fontSize: 10.5 }} />
          )}
        </Stack>

        <Collapse in={isOpen} unmountOnExit>
          {kids.map((k) => renderNode(k, level + 1))}
        </Collapse>
      </Box>
    );
  };

  const roots = tree.get(null) ?? [];

  return (
    <Stack spacing={2.5}>
      {error && <Alert severity="error" onClose={() => setError("")}>{error}</Alert>}
      {notice && <Alert severity="info" onClose={() => setNotice("")}>{notice}</Alert>}

      {/* --- discover ---------------------------------------------------- */}
      <Paper sx={{ p: 3 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
          <Typography variant="overline">Discover pages</Typography>
          {sessionOpen
            ? <Chip size="small" color="success" label="Session open" />
            : <Chip size="small" variant="outlined" label="No session" />}
        </Stack>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} sx={{ mt: 1.5 }} alignItems={{ md: "center" }}>
          <TextField select size="small" label="Source" value={source} sx={{ width: 170, flexShrink: 0 }}
                     onChange={(e) => setSource(e.target.value as typeof source)}>
            <MenuItem value="crawl">Crawl from root URL</MenuItem>
            <MenuItem value="sitemap">Import sitemap.xml</MenuItem>
            <MenuItem value="list">Paste URL list</MenuItem>
          </TextField>

          {source !== "list" ? (
            <TextField size="small" value={seed} onChange={(e) => setSeed(e.target.value)}
              label={source === "sitemap" ? "Sitemap URL" : "Root URL"}
              placeholder={source === "sitemap" ? "https://example.com/sitemap.xml" : "https://example.com"}
              sx={{ flex: 1, minWidth: 260, maxWidth: 560 }} />
          ) : (
            <TextField size="small" fullWidth multiline minRows={2} maxRows={6}
              label="URLs (one per line)" value={listText}
              onChange={(e) => setListText(e.target.value)} />
          )}

          {source === "crawl" && (
            <>
              <TextField size="small" type="number" label="Max pages" value={maxPages} sx={{ width: 110, flexShrink: 0 }}
                         onChange={(e) => setMaxPages(Math.max(1, Math.min(2000, +e.target.value || 100)))} />
              <TextField size="small" type="number" label="Max depth" value={maxDepth} sx={{ width: 110, flexShrink: 0 }}
                         onChange={(e) => setMaxDepth(Math.max(1, Math.min(10, +e.target.value || 3)))} />
            </>
          )}

          {/* Start a Chrome session for manual login. Disabled once one is open. */}
          <Button variant={sessionOpen ? "outlined" : "contained"} color={sessionOpen ? "success" : "primary"}
                  startIcon={<OpenInBrowserIcon />} onClick={startSession}
                  disabled={sessionBusy || sessionOpen} sx={{ whiteSpace: "nowrap", flexShrink: 0 }}>
            {sessionBusy ? "Starting…" : sessionOpen ? "Session ready" : "Start Session"}
          </Button>

          {status?.running ? (
            <Button variant="outlined" color="error" startIcon={<StopIcon />}
                    onClick={() => api.crawlStop().catch(() => {})} sx={{ whiteSpace: "nowrap", flexShrink: 0 }}>
              Stop
            </Button>
          ) : (
            <Tooltip title={sessionOpen ? "" : "Start a browser session first so discovery runs inside your logged-in Chrome."}>
              <span>
                <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={startCrawl}
                        disabled={!sessionOpen} sx={{ whiteSpace: "nowrap", flexShrink: 0 }}>
                  Discover
                </Button>
              </span>
            </Tooltip>
          )}
        </Stack>

        {source === "crawl" && (
          <Stack direction="row" spacing={2} sx={{ mt: 1 }} flexWrap="wrap">
            <Tooltip title="Only discover pages under the root URL's section (e.g. /ecare/…). Links up to the domain root or other sections are ignored.">
              <FormControlLabel
                control={<Checkbox size="small" checked={confinePath} onChange={(e) => setConfinePath(e.target.checked)} />}
                label={<Typography variant="body2">Stay within URL path</Typography>}
              />
            </Tooltip>
            <Tooltip title="Ignore links in the global header, primary nav, and footer (site chrome). In-app side menus inside the page content are still followed.">
              <FormControlLabel
                control={<Checkbox size="small" checked={skipChrome} onChange={(e) => setSkipChrome(e.target.checked)} />}
                label={<Typography variant="body2">Skip header / nav / footer links</Typography>}
              />
            </Tooltip>
          </Stack>
        )}

        {source === "crawl" && (
          <TextField
            size="small" fullWidth multiline minRows={2} maxRows={6} sx={{ mt: 1.5 }}
            label="Section URLs (optional, one per line)"
            placeholder={"/ecare/products\n/ecare/finance\n/ecare/orders\n/ecare/settings/profile\n/ecare/support/tickets"}
            value={seedUrlsText}
            onChange={(e) => setSeedUrlsText(e.target.value)}
            helperText="Guaranteed starting points — each is crawled directly and its subpages discovered from there. Use when a section isn't linked from the landing page. Relative (/ecare/orders) or full URLs both work."
          />
        )}

        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
          Click <strong>Start Session</strong> to open Chrome, log in manually if the site needs it, then <strong>Discover</strong>.
          Discovery is read-only: it reads links, and never clicks, submits, or follows a logout link.
          {confinePath && source === "crawl" && seedPathHint}
        </Typography>

        {status?.running && (
          <Box sx={{ mt: 2 }}>
            <LinearProgress />
            <Typography variant="body2" sx={{ mt: 1 }}>
              {status.discovered} page{status.discovered === 1 ? "" : "s"} discovered
            </Typography>
            <Typography variant="caption" color="primary" noWrap sx={{ display: "block" }}>
              {status.currentUrl}
            </Typography>
            <Stack sx={{ mt: 1 }}>
              {status.log.slice(-5).map((l, i) => (
                <Typography key={i} variant="caption" color="text.secondary"
                            sx={{ fontFamily: "monospace" }} noWrap>{l.msg}</Typography>
              ))}
            </Stack>
          </Box>
        )}
      </Paper>

      {/* --- saved crawls -------------------------------------------------- */}
      <Paper sx={{ p: 3 }}>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Typography variant="overline" sx={{ flex: 1 }}>Saved crawls</Typography>
          <input ref={fileRef} type="file" accept=".json" hidden
                 onChange={(e) => e.target.files?.[0] && importConfig(e.target.files[0])} />
          <Button size="small" startIcon={<UploadIcon />} onClick={() => fileRef.current?.click()}>
            Import config
          </Button>
        </Stack>

        {!crawls.length && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
            No crawls yet. Discover a site above, or import a saved configuration.
          </Typography>
        )}

        <Stack spacing={1} sx={{ mt: 1.5 }}>
          {crawls.map((c) => (
            <Stack key={c.id} direction="row" spacing={1.5} alignItems="center"
                   onClick={() => loadCrawl(c.id)}
                   sx={{ p: 1.25, borderRadius: 1.5, cursor: "pointer",
                         bgcolor: selectedId === c.id ? "rgba(138,199,255,0.10)" : "#0E1116",
                         border: "1px solid", borderColor: selectedId === c.id ? "primary.main" : "transparent" }}>
              <AccountTreeIcon fontSize="small" sx={{ color: "text.secondary" }} />
              <Stack sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>{c.name}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {c.source} · {c.urlCount} pages · {c.enabledCount} enabled ·{" "}
                  {new Date(c.created_at).toLocaleString()}
                </Typography>
              </Stack>
              <Tooltip title="Delete crawl">
                <IconButton size="small" aria-label={`Delete ${c.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    api.crawlDelete(c.id).then(() => {
                      refreshCrawls();
                      if (selectedId === c.id) { setSelectedId(null); setUrls([]); }
                    }).catch(() => {});
                  }}>
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          ))}
        </Stack>
      </Paper>

      {/* --- tree ---------------------------------------------------------- */}
      {selectedId && (
        <Paper sx={{ p: 3 }}>
          <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap>
            <Typography variant="overline" sx={{ flex: 1 }}>
              Page tree — {enabledUrls.length} of {urls.length} enabled for scanning
            </Typography>
            <Button size="small" startIcon={<RefreshIcon />}
                    onClick={() => api.crawlRecrawl(selectedId).then(() => {
                      setNotice("Re-crawling enabled pages — your enable/disable choices are preserved.");
                      pollRef.current = window.setInterval(async () => {
                        const st = await api.crawlStatus().catch(() => null);
                        if (!st?.ok) return;
                        setStatus(st);
                        if (!st.running) { stopPolling(); setStatus(null); loadCrawl(selectedId); }
                      }, 1000);
                    }).catch(() => {})}>
              Re-crawl enabled
            </Button>
            <Button size="small" startIcon={<DownloadIcon />} onClick={exportConfig}>Export config</Button>
            <Button size="small" variant="contained" color="secondary" startIcon={<SendIcon />}
                    onClick={sendToScan}>
              Scan {enabledUrls.length} page{enabledUrls.length === 1 ? "" : "s"}
            </Button>
          </Stack>

          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mt: 2 }} flexWrap="wrap" useFlexGap>
            <TextField size="small" placeholder="Search URL or title…" value={query}
              onChange={(e) => setQuery(e.target.value)} sx={{ flex: 1, minWidth: 220 }}
              InputProps={{ startAdornment: (
                <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>
              ) }} />
            <ToggleButtonGroup size="small" exclusive value={filter}
                               onChange={(_, v) => v && setFilter(v)}>
              <ToggleButton value="all">All</ToggleButton>
              <ToggleButton value="enabled">Enabled</ToggleButton>
              <ToggleButton value="disabled">Disabled</ToggleButton>
              <ToggleButton value="errors">Errors</ToggleButton>
            </ToggleButtonGroup>
            <Button size="small" onClick={() => setEnabled(urls.map((u) => u.url), true)}>Enable all</Button>
            <Button size="small" color="inherit" onClick={() => setEnabled(urls.map((u) => u.url), false)}>Disable all</Button>
          </Stack>

          <Divider sx={{ my: 1.5 }} />

          <Box sx={{ maxHeight: 520, overflow: "auto" }}>
            {roots.length ? roots.map((r) => renderNode(r, 0)) : (
              <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                No pages match the current filter.
              </Typography>
            )}
          </Box>
        </Paper>
      )}
    </Stack>
  );
}
