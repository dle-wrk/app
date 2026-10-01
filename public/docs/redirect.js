/* Loaded by /tracklab-complete-guide.html (the old single-page guide).
   Sends the visitor to the topic page that now holds the section their
   link pointed at. Lives in its own file because the server's
   Content-Security-Policy blocks inline <script>. */
(function () {
  var map = {
    'whats-new-v28': 'release-notes.html#whats-new-v28',
    'whats-new-v27': 'release-notes.html#whats-new-v27',
    'whats-new': 'release-notes.html#whats-new',
    'getting-started': 'getting-started.html',
    'dashboard': 'getting-started.html#dashboard',
    'inventory': 'inventory.html',
    'suppliers': 'suppliers-pricing.html#suppliers',
    'pricing': 'suppliers-pricing.html#pricing',
    'manufacturing': 'manufacturing.html',
    'bookkeeping': 'accounting.html',
    'automation': 'automation-quality.html#automation',
    'quality': 'automation-quality.html#quality',
    'advanced': 'automation-quality.html#advanced-automation',
    'tips': 'admin-tips.html#tips'
  };
  var anchor = (location.hash || '').slice(1);
  location.replace('docs/' + (map[anchor] || 'index.html'));
})();
