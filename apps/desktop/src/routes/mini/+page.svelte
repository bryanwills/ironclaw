<script lang="ts">
  // LANE B7 (R64) — Mini-mode route entry.
  //
  // The Tauri child window opened by `open_mini_window` loads this URL.
  // Rendering is delegated to `MiniPanel.svelte` (a fixed-position
  // overlay) so the panel covers the main `+layout.svelte`'s sidebar +
  // statusbar chrome inside the 320×400 webview.
  import MiniPanel from '$lib/components/MiniPanel.svelte';
</script>

<MiniPanel />
