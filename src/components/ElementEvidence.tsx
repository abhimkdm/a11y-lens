import { useState } from "react";
import {
  Box, Button, Collapse, Typography, Stack, Chip, Dialog, DialogContent, IconButton,
} from "@mui/material";
import ImageIcon from "@mui/icons-material/Image";
import CloseIcon from "@mui/icons-material/Close";
import ZoomInIcon from "@mui/icons-material/ZoomIn";
import type { ViolationNode } from "../store/useAppStore";

// The screenshot of a single failing element, highlighted in place.
//
// A selector tells a developer where the problem is; it does not tell them which
// of five near-identical banners is actually broken. This closes that gap —
// collapsed by default so it never gets in the way of scanning the list.
export default function ElementEvidence({ node }: { node: ViolationNode }) {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(false);

  if (!node.screenshot) {
    // Be honest about *why* there's no picture rather than showing nothing.
    const reason =
      node.screenshotSkipped === "budget"
        ? "Not captured — screenshot limit reached for this scan"
        : node.screenshotSkipped === "not-found"
        ? "Element could not be located on the page when the screenshot was taken"
        : node.screenshotSkipped === "capture-failed"
        ? "Screenshot capture failed for this element"
        : null;
    if (!reason) return null;
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
        {reason}
      </Typography>
    );
  }

  const src = `data:image/jpeg;base64,${node.screenshot}`;

  return (
    <Box sx={{ mt: 1 }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button size="small" startIcon={<ImageIcon />} onClick={() => setOpen((v) => !v)}
                aria-expanded={open}>
          {open ? "Hide visual evidence" : "Show visual evidence"}
        </Button>
        {node.elementTiny && (
          <Chip size="small" color="warning" variant="outlined"
                label="Element is 0×0 — invisible on the page" />
        )}
      </Stack>

      <Collapse in={open} unmountOnExit>
        <Box sx={{ mt: 1, position: "relative", display: "inline-block", maxWidth: "100%" }}>
          <Box
            component="img"
            src={src}
            alt="Screenshot of the failing element, outlined on the page"
            sx={{
              display: "block", maxWidth: "100%", borderRadius: 1.5,
              border: "1px solid rgba(154,167,180,0.25)", cursor: "zoom-in",
            }}
            onClick={() => setZoom(true)}
          />
          <IconButton
            size="small"
            onClick={() => setZoom(true)}
            aria-label="Open full size"
            sx={{
              position: "absolute", top: 6, right: 6,
              bgcolor: "rgba(14,17,22,0.75)",
              "&:hover": { bgcolor: "rgba(14,17,22,0.95)" },
            }}
          >
            <ZoomInIcon fontSize="small" />
          </IconButton>
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
          The failing element is outlined in its severity colour, with surrounding page context.
        </Typography>
      </Collapse>

      <Dialog open={zoom} onClose={() => setZoom(false)} maxWidth="xl">
        <DialogContent sx={{ p: 0, position: "relative", bgcolor: "#0E1116" }}>
          <IconButton
            onClick={() => setZoom(false)}
            aria-label="Close"
            sx={{ position: "absolute", top: 8, right: 8, bgcolor: "rgba(14,17,22,0.8)", zIndex: 1 }}
          >
            <CloseIcon />
          </IconButton>
          <Box component="img" src={src}
               alt="Screenshot of the failing element, outlined on the page, full size"
               sx={{ display: "block", maxWidth: "90vw", maxHeight: "90vh" }} />
        </DialogContent>
      </Dialog>
    </Box>
  );
}
