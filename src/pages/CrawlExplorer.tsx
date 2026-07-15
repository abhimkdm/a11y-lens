import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Paper, Typography, Stack, Button, TextField, MenuItem, Checkbox, Chip, Box,
  Alert, LinearProgress, IconButton, Tooltip, Collapse, Divider, ToggleButton,
  ToggleButtonGroup, InputAdornment,
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
  const { setPendingUrlList } = useAppStore();

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

  const [status, setStatus] = useState<{ running: boolean; discovered: number; currentUrl: string | null; log: { msg: string }[] } | null>(null);
  const pollRef = useRef<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshCrawls = useCallback(() => {
    api.crawlList().then((r) => r.ok && setCrawls(r.crawls)).catch(() => {});
  }, []);

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
        : { source, rootUrl: seed, maxPages, maxDepth };

    const r = await api.crawlStart(opts).catch((e) => ({ ok: false, error: String(e) }));
    if (!r.ok) { setError(r.error ?? "Could not start the crawl"); return; }
    if (!r.usingSession) {
      setNotice("No browser session is open, so pages behind a login won't be discovered. Open a session in Scan Center first if the site needs authentication.");
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
        <Typography variant="overline">Discover pages</Typography>
        <Stack direction={{ xs: "column", md: "row" }} spacing={1.5} sx={{ mt: 1.5 }}>
          <TextField select size="small" label="Source" value={source} sx={{ width: 170 }}
                     onChange={(e) => setSource(e.target.value as typeof source)}>
            <MenuItem value="crawl">Crawl from root URL</MenuItem>
            <MenuItem value="sitemap">Import sitemap.xml</MenuItem>
            <MenuItem value="list">Paste URL list</MenuItem>
          </TextField>

          {source !== "list" ? (
            <TextField size="small" fullWidth value={seed} onChange={(e) => setSeed(e.target.value)}
              label={source === "sitemap" ? "Sitemap URL" : "Root URL"}
              placeholder={source === "sitemap" ? "https://example.com/sitemap.xml" : "https://example.com"} />
          ) : (
            <TextField size="small" fullWidth multiline minRows={2} maxRows={6}
              label="URLs (one per line)" value={listText}
              onChange={(e) => setListText(e.target.value)} />
          )}

          {source === "crawl" && (
            <>
              <TextField size="small" type="number" label="Max pages" value={maxPages} sx={{ width: 110 }}
                         onChange={(e) => setMaxPages(Math.max(1, Math.min(2000, +e.target.value || 100)))} />
              <TextField size="small" type="number" label="Max depth" value={maxDepth} sx={{ width: 110 }}
                         onChange={(e) => setMaxDepth(Math.max(1, Math.min(10, +e.target.value || 3)))} />
            </>
          )}

          {status?.running ? (
            <Button variant="outlined" color="error" startIcon={<StopIcon />}
                    onClick={() => api.crawlStop().catch(() => {})} sx={{ whiteSpace: "nowrap" }}>
              Stop
            </Button>
          ) : (
            <Button variant="contained" startIcon={<PlayArrowIcon />} onClick={startCrawl}
                    sx={{ whiteSpace: "nowrap" }}>
              Discover
            </Button>
          )}
        </Stack>

        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
          Discovery is read-only: it reads links, and never clicks, submits, or follows a logout link.
          If the site needs a login, open a browser session in Scan Center first — the crawl runs inside it.
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
