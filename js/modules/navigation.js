/* ---------------------------------------------------------------
   NAVIGATION - top-level page tabs and the Duty Builder sidebar tabs.
   CORE. A disabled optional module's nav tab is hidden via its own
   hideSelectors (see moduleRegistry.js) rather than anything here, so
   this file needs no module-awareness of its own.
   --------------------------------------------------------------- */
function wireNav(){
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.getElementById(btn.dataset.page).classList.add('active');
      if (btn.dataset.page === 'pageDutySheet') { renderCalendar(); requestAnimationFrame(updateStickyOffsets); }
      if (btn.dataset.page === 'pageRotaSheet') renderRotaSheet();
    });
  });
  window.addEventListener('resize', () => {
    clearTimeout(window.__stickyResizeTimer);
    window.__stickyResizeTimer = setTimeout(updateStickyOffsets, 150);
  });
  document.getElementById('sidebarToggle').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.toggle('collapsed');
    const collapsed = sidebar.classList.contains('collapsed');
    document.getElementById('sidebarToggle').textContent = collapsed ? '\u00bb' : '\u00ab';
    document.getElementById('sidebarToggle').title = collapsed ? 'Expand' : 'Collapse';
  });
  document.querySelectorAll('.sidebar-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.sidebar-pane').forEach(p => p.classList.remove('active'));
      document.getElementById(btn.dataset.pane).classList.add('active');
    });
  });
}
