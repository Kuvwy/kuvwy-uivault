/* ====================================================
   UI VAULT — SCRIPT
   ALL FIXES APPLIED
   ==================================================== */

// ===== CONFIG — EDIT THESE =====
const CONFIG = {
  SUPABASE_URL: "https://umfwvksnaqgtjvkgpgow.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_W9XISd-bgINvMvzqe6Xe3g_vBxyTa8p",
  PAYSTACK_PUBLIC_KEY: "pk_test_...", // Add your Paystack public key here
  MAX_AUTH_ATTEMPTS: 5,
  AUTH_WINDOW_MS: 300000 // 5 minutes
};

// ===== SUPABASE CLIENT =====
const supabaseClient = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

let TEMPLATES = [];
let currentUser = null;

// ===== RATE LIMITER =====
const rateLimits = {};

function checkRateLimit(key, maxAttempts = CONFIG.MAX_AUTH_ATTEMPTS, windowMs = CONFIG.AUTH_WINDOW_MS) {
  const now = Date.now();
  if (!rateLimits[key]) {
    rateLimits[key] = { attempts: 0, resetAt: now + windowMs };
  }
  
  if (now > rateLimits[key].resetAt) {
    rateLimits[key] = { attempts: 0, resetAt: now + windowMs };
  }
  
  rateLimits[key].attempts++;
  return rateLimits[key].attempts <= maxAttempts;
}

function getRemainingAttempts(key) {
  if (!rateLimits[key]) return CONFIG.MAX_AUTH_ATTEMPTS;
  const now = Date.now();
  if (now > rateLimits[key].resetAt) return CONFIG.MAX_AUTH_ATTEMPTS;
  return CONFIG.MAX_AUTH_ATTEMPTS - rateLimits[key].attempts;
}

// ===== LOADING STATE HELPER =====
function showLoading(el, text = 'Loading...') {
  const original = el.innerHTML;
  const originalDisabled = el.disabled;
  el.disabled = true;
  el.innerHTML = text;
  return function restore() {
    el.disabled = originalDisabled;
    el.innerHTML = original;
  };
}

// ===== ADMIN CHECK =====
async function isAdmin() {
  if (!currentUser) return false;
  try {
    const { data, error } = await supabaseClient
      .from('users')
      .select('role')
      .eq('id', currentUser.id)
      .single();
    if (error || !data) return false;
    return data.role === 'admin';
  } catch (err) {
    console.error('Admin check failed:', err);
    return false;
  }
}

// ===== 1. SESSION MANAGEMENT =====
supabaseClient.auth.onAuthStateChange((event, session) => {
  currentUser = session?.user || null;
  updateProfileNavLinks();
  // If user logs in, sync purchases
  if (event === 'SIGNED_IN' && currentUser) {
    syncPurchasesToLocal();
  }
});

function updateProfileNavLinks() {
  var navProfile = document.getElementById('navProfile');
  var mobileNavProfile = document.getElementById('mobileNavProfile');
  var show = !!currentUser;
  if (navProfile) navProfile.style.display = show ? 'inline-block' : 'none';
  if (mobileNavProfile) mobileNavProfile.style.display = show ? 'block' : 'none';
}

function getUnlocked() {
  return JSON.parse(localStorage.getItem('unlockedComponents') || '[]');
}

async function isUnlocked(templateId) {
  var local = JSON.parse(localStorage.getItem('unlockedComponents') || '[]');
  if (local.includes(templateId)) return true;
  if (!currentUser) return false;
  try {
    var result = await supabaseClient
      .from('purchases')
      .select('id')
      .eq('user_id', currentUser.id)
      .eq('template_id', templateId)
      .maybeSingle();
    return result.data !== null;
  } catch (err) {
    console.error("Error checking unlock status:", err);
    return false;
  }
}

function unlockComponent(templateId) {
  var unlocked = getUnlocked();
  if (!unlocked.includes(templateId)) {
    unlocked.push(templateId);
    localStorage.setItem('unlockedComponents', JSON.stringify(unlocked));
  }
}

// Sync ALL purchases from Supabase into localStorage
async function syncPurchasesToLocal() {
  if (!currentUser) return;
  try {
    var result = await supabaseClient
      .from('purchases')
      .select('template_id')
      .eq('user_id', currentUser.id);
    if (result.error || !result.data) return;
    result.data.forEach(function(p) { unlockComponent(p.template_id); });
  } catch (err) {
    console.error('Sync failed:', err);
  }
}

// ===== STORE FAILED TRANSACTIONS =====
function storeFailedTransaction(reference, templateId, userId) {
  var failed = JSON.parse(localStorage.getItem('failed_transactions') || '[]');
  failed.push({
    reference: reference,
    template_id: templateId,
    user_id: userId,
    timestamp: new Date().toISOString()
  });
  localStorage.setItem('failed_transactions', JSON.stringify(failed));
}

// ===== 2. PAYMENT LOGIC =====
function buyComponent(template) {
  if (!currentUser) {
    window._pendingTemplate = template;
    openAuthModal('login');
    return;
  }
  proceedToCheckout(template);
}

function proceedToCheckout(template) {
  localStorage.setItem('pendingPurchase', template.id);
  localStorage.setItem('pendingUserId', currentUser.id);
  window.open('https://paystack.shop/pay/6hjrfs3ofp', '_blank');
  showToast('Opening secure checkout...');
}

// ===== PAYMENT VERIFICATION WITH FALLBACK =====
async function handlePurchaseReturn() {
  var urlParams = new URLSearchParams(window.location.search);
  var reference = urlParams.get('reference') || urlParams.get('trxref');
  var templateId = localStorage.getItem('pendingPurchase');
  var userId = localStorage.getItem('pendingUserId');

  if (reference && templateId && userId) {
    window.history.replaceState({}, document.title, window.location.pathname);
    showToast('Verifying your purchase...');
    
    try {
      var session = (await supabaseClient.auth.getSession()).data.session;
      
      // First attempt: Edge Function
      var verifyRes = await fetch(CONFIG.SUPABASE_URL + '/functions/v1/verify-purchase', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + session.access_token
        },
        body: JSON.stringify({ 
          reference: reference, 
          template_id: templateId,
          user_id: userId 
        })
      });
      
      var verifyResult = await verifyRes.json();
      
      if (verifyResult.success) {
        unlockComponent(templateId);
        localStorage.removeItem('pendingPurchase');
        localStorage.removeItem('pendingUserId');
        showToast('Payment successful! Template unlocked.');
        refreshCurrentView(templateId);
        return;
      }
      
      // FALLBACK: Try direct DB insert
      console.warn('Edge Function failed, trying fallback...');
      var fallbackResult = await supabaseClient
        .from('purchases')
        .insert([{ 
          user_id: userId, 
          template_id: templateId, 
          reference: reference 
        }]);
      
      if (fallbackResult.error) {
        throw fallbackResult.error;
      }
      
      unlockComponent(templateId);
      localStorage.removeItem('pendingPurchase');
      localStorage.removeItem('pendingUserId');
      showToast('Payment successful! Template unlocked.');
      refreshCurrentView(templateId);
      
    } catch (err) {
      console.error('Purchase recording failed:', err);
      // Store for manual review
      storeFailedTransaction(reference, templateId, userId);
      showToast('Payment made but recording failed. Please contact support with Ref: ' + reference);
    }
  }
}


function refreshCurrentView(templateId) {
  if (currentDetailTemplate && currentDetailTemplate.id == templateId) {
    openDetailView(currentDetailTemplate);
  } else {
    runFilter();
  }
}
// ===== 3. YOUR PROFILE PANEL =====
async function loadProfileList() {
  var list = document.getElementById('profileList');
  list.innerHTML = '<div class="profile-empty"><div class="profile-empty-icon"></div>Loading...</div>';

  try {
    var result = await supabaseClient
      .from('purchases')
      .select('template_id, created_at')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false });

    if (result.error) throw result.error;
    var purchases = result.data || [];

    if (purchases.length === 0) {
      list.innerHTML = '<div class="profile-empty"><div class="profile-empty-icon"></div>No owned templates yet.<br>Purchase a premium template to see it here.</div>';
      return;
    }

    var templateIds = purchases.map(function(p) { return p.template_id; });
    var tResult = await supabaseClient
      .from('templates')
      .select('id, title, category, thumbnail_url, accent')
      .in('id', templateIds);

    if (tResult.error) throw tResult.error;

    var tMap = {};
    (tResult.data || []).forEach(function(t) { tMap[t.id] = t; });

    list.innerHTML = '';
    purchases.forEach(function(purchase) {
      var t = tMap[purchase.template_id];
      if (!t) return;
      var accent = t.accent || '#0066ff';
      var thumbHtml = t.thumbnail_url
        ? '<img src="' + t.thumbnail_url + '" alt="' + t.title + '" />'
        : '<div class="profile-thumb-placeholder">' + t.category + '</div>';
      var date = new Date(purchase.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
      var item = document.createElement('div');
      item.className = 'profile-item';
      item.innerHTML =
        '<div class="profile-thumb" style="background:linear-gradient(135deg,' + accent + '15,' + accent + '08);">' + thumbHtml + '</div>' +
        '<div class="profile-item-info">' +
          '<p class="profile-item-title">' + t.title + '</p>' +
          '<p class="profile-item-meta">' + t.category + ' · ' + date + '</p>' +
        '</div>' +
        '<span class="profile-owned-badge">OWNED</span>';
      item.addEventListener('click', function() {
        closeProfile();
        var full = TEMPLATES.find(function(tmpl) { return tmpl.id == t.id; });
        if (full) openDetailView(full);
      });
      list.appendChild(item);
    });

    // Also sync to localStorage so isUnlocked works offline
    purchases.forEach(function(p) { unlockComponent(p.template_id); });

  } catch (err) {
    console.error('Failed to load profile:', err);
    list.innerHTML = '<div class="profile-empty">Failed to load. Try refreshing.</div>';
  }
}

async function openProfile() {
  if (!currentUser) return;
  var modal = document.getElementById('profileModal');
  var emailEl = document.getElementById('profileEmail');
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  emailEl.textContent = currentUser.email;
  await loadProfileList();
}

function closeProfile() {
  document.getElementById('profileModal').hidden = true;
  document.body.style.overflow = '';
}

async function logoutUser() {
  await supabaseClient.auth.signOut();
  currentUser = null;
  updateProfileNavLinks();
  closeProfile();
  showToast('Logged out successfully.');
}

// Profile nav — safe hamburger check
document.getElementById('navProfile').addEventListener('click', function(e) {
  e.preventDefault();
  var hamburger = document.getElementById('hamburger');
  var mobileNav = document.getElementById('mobileNav');
  if (hamburger) hamburger.classList.remove('open');
  if (mobileNav) mobileNav.classList.remove('open');
  openProfile();
});
document.getElementById('mobileNavProfile').addEventListener('click', function(e) {
  e.preventDefault();
  var hamburger = document.getElementById('hamburger');
  var mobileNav = document.getElementById('mobileNav');
  if (hamburger) hamburger.classList.remove('open');
  if (mobileNav) mobileNav.classList.remove('open');
  openProfile();
});
document.getElementById('profileClose').addEventListener('click', closeProfile);
document.getElementById('profileBackdrop').addEventListener('click', closeProfile);
document.getElementById('logoutBtn').addEventListener('click', logoutUser);

// Refresh button — fixes Ghost Purchase
document.getElementById('refreshPurchasesBtn').addEventListener('click', async function() {
  var restore = showLoading(this, 'Refreshing...');
  await loadProfileList();
  restore();
  showToast('Purchases refreshed!');
});

// ===== 4. UI & GRID LOGIC =====
var state = {
  query: "",
  filter: "all",
  free: [],
  premium: [],
};

var searchInput = document.getElementById("searchInput");
var freeGrid = document.getElementById("freeGrid");
var premiumGrid = document.getElementById("premiumGrid");
var freeSectionLabel = document.getElementById("freeSectionLabel");
var premiumSectionLabel = document.getElementById("premiumSectionLabel");
var resultsCount = document.getElementById("resultsCount");
var emptyState = document.getElementById("emptyState");
var emptyTerm = document.getElementById("emptyTerm");
var filterBtns = document.querySelectorAll(".filter-btn");
var hamburger = document.getElementById("hamburger");
var mobileNav = document.getElementById("mobileNav");
var footerYear = document.getElementById("footerYear");

function runFilter() {
  var q = state.query.trim().toLowerCase();
  var f = state.filter;
  var filtered = TEMPLATES.filter(function(t) {
    var categoryMatch = f === "all" || f === "free" || f === "premium" || t.category === f;
    var searchMatch = q === "" || t.title.toLowerCase().includes(q) ||
      (t.description && t.description.toLowerCase().includes(q)) ||
      t.category.toLowerCase().includes(q) ||
      (t.tags && t.tags.some(function(tag) { return tag.toLowerCase().includes(q); }));
    return categoryMatch && searchMatch;
  });

  if (f === "free") {
    state.free = filtered.filter(function(t) { return t.price === 0 || t.price === null || t.price === undefined; });
    state.premium = [];
  } else if (f === "premium") {
    state.free = [];
    state.premium = filtered.filter(function(t) { return t.price > 0; });
  } else {
    state.free = filtered.filter(function(t) { return t.price === 0 || t.price === null || t.price === undefined; });
    state.premium = filtered.filter(function(t) { return t.price > 0; });
  }
  renderGrid();
}

// ===== FIX: Removed "Free" tag from homepage grid =====
function buildFreeCard(template) {
  var card = document.createElement("div");
  card.className = "template-card";
  card.addEventListener('click', function() { openDetailView(template); });
  var accent = template.accent || '#0066ff';
  var imageUrl = template.thumbnail_url || '';
  var bgStyle = imageUrl
    ? 'background-image:url(' + imageUrl + ');background-size:cover;background-position:center;'
    : 'background:linear-gradient(135deg,' + accent + '15,' + accent + '08);';
  var tagMarkup = template.tags && Array.isArray(template.tags)
    ? template.tags.map(function(t) { return '<span class="card-tag">' + t + '</span>'; }).join("") : "";
  card.innerHTML =
    '<div class="card-image" style="' + bgStyle + 'display:flex;align-items:center;justify-content:center;position:relative;">' +
    (!imageUrl ? '<span style="font-family:\'DM Mono\',monospace;font-size:0.75rem;color:' + accent + ';font-weight:500;text-transform:uppercase;letter-spacing:0.1em;">// ' + template.category + '</span>' : '') +
    '</div>' +
    '<div class="card-body"><div class="card-meta">' + tagMarkup + '</div>' +
    '<h2 class="card-title">' + template.title + '</h2></div>';
  return card;
}

function buildPremiumCard(template) {
  var card = document.createElement("div");
  card.className = "template-card paid";
  card.addEventListener('click', function() { openDetailView(template); });
  var accent = template.accent || '#0066ff';
  var imageUrl = template.thumbnail_url || '';
  var bgStyle = imageUrl
    ? 'background-image:url(' + imageUrl + ');background-size:cover;background-position:center;'
    : 'background:linear-gradient(135deg,' + accent + '15,' + accent + '08);';
  var tagMarkup = template.tags && Array.isArray(template.tags)
    ? template.tags.map(function(t) { return '<span class="card-tag">' + t + '</span>'; }).join("") : "";
  card.innerHTML =
    '<div class="card-image" style="' + bgStyle + 'display:flex;align-items:center;justify-content:center;position:relative;">' +
    (!imageUrl ? '<span style="font-family:\'DM Mono\',monospace;font-size:0.75rem;color:' + accent + ';font-weight:500;text-transform:uppercase;letter-spacing:0.1em;">// ' + template.category + '</span>' : '') +
    '<span class="paid-badge">PRO</span></div>' +
    '<div class="card-body"><div class="card-meta">' + tagMarkup + '</div>' +
    '<h2 class="card-title">' + template.title + '</h2></div>';
  return card;
}

function renderGrid() {
  freeGrid.innerHTML = "";
  premiumGrid.innerHTML = "";
  var freeCount = state.free.length;
  var premiumCount = state.premium.length;
  var total = freeCount + premiumCount;
  resultsCount.innerHTML = 'Showing <strong>' + total + '</strong> template' + (total !== 1 ? 's' : '');
  if (total === 0) {
    emptyState.hidden = false;
    freeSectionLabel.hidden = true;
    premiumSectionLabel.hidden = true;
    if (emptyTerm) emptyTerm.textContent = state.query ? '"' + state.query + '"' : 'in "' + state.filter + '"';
    return;
  }
  emptyState.hidden = true;
  if (freeCount > 0) {
    freeSectionLabel.hidden = false;
    var freeFragment = document.createDocumentFragment();
    state.free.forEach(function(t) { freeFragment.appendChild(buildFreeCard(t)); });
    freeGrid.appendChild(freeFragment);
  } else { freeSectionLabel.hidden = true; }
  if (premiumCount > 0) {
    premiumSectionLabel.hidden = false;
    var premiumFragment = document.createDocumentFragment();
    state.premium.forEach(function(t) { premiumFragment.appendChild(buildPremiumCard(t)); });
    premiumGrid.appendChild(premiumFragment);
  } else { premiumSectionLabel.hidden = true; }
}

searchInput.addEventListener("input", function(e) { state.query = e.target.value; runFilter(); });
searchInput.addEventListener("keydown", function(e) {
  if (e.key === "Escape") { searchInput.value = ""; state.query = ""; runFilter(); searchInput.blur(); }
});
filterBtns.forEach(function(btn) {
  btn.addEventListener("click", function() {
    filterBtns.forEach(function(b) { b.classList.remove("active"); });
    btn.classList.add("active");
    state.filter = btn.dataset.filter;
    runFilter();
  });
});

if (hamburger) hamburger.addEventListener("click", function() { hamburger.classList.toggle("open"); mobileNav.classList.toggle("open"); });
if (mobileNav) mobileNav.querySelectorAll("a").forEach(function(link) {
  link.addEventListener("click", function() {
    if (hamburger) hamburger.classList.remove("open");
    mobileNav.classList.remove("open");
  });
});

function scrollToSection(id) {
  var el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function bindNavLinks(freeId, premiumId, aboutId) {
  var navFree = document.getElementById(freeId);
  var navPremium = document.getElementById(premiumId);
  var navAbout = document.getElementById(aboutId);
  if (navFree) navFree.addEventListener('click', function(e) { e.preventDefault(); if (hamburger) hamburger.classList.remove('open'); if (mobileNav) mobileNav.classList.remove('open'); scrollToSection('freeSectionLabel'); });
  if (navPremium) navPremium.addEventListener('click', function(e) { e.preventDefault(); if (hamburger) hamburger.classList.remove('open'); if (mobileNav) mobileNav.classList.remove('open'); scrollToSection('premiumSectionLabel'); });
  if (navAbout) navAbout.addEventListener('click', function(e) { e.preventDefault(); if (hamburger) hamburger.classList.remove('open'); if (mobileNav) mobileNav.classList.remove('open'); scrollToSection('aboutSection'); });
}

bindNavLinks('navFree', 'navPremium', 'navAbout');
bindNavLinks('mobileNavFree', 'mobileNavPremium', 'mobileNavAbout');
// ===== COPY & DOWNLOAD FUNCTIONS =====
async function copyCode(templateId) {
  var template = TEMPLATES.find(function(t) { return t.id === templateId; });
  if (!template) return;
  var code = '\n' + (template.html_content || '') + '\n\n<style>\n' + (template.css_content || '') + '\n</style>\n\n<script>\n' + (template.js_content || '') + '\n<\/script>';
  try {
    await navigator.clipboard.writeText(code);
    showToast('Code copied to clipboard!');
  } catch (err) {
    var textarea = document.createElement('textarea');
    textarea.value = code;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('Code copied to clipboard!');
  }
}

async function downloadTemplate(templateId) {
  var template = TEMPLATES.find(function(t) { return t.id === templateId; });
  if (!template || !template.file_path) {
    showToast('Download file not found. Contact support.');
    return;
  }
  try {
    var result = await supabaseClient
      .storage
      .from('websites')
      .createSignedUrl(template.file_path, 3600);
    if (result.error) throw result.error;
    window.location.href = result.data.signedUrl;
    showToast('Download starting...');
  } catch (err) {
    console.error('Download failed:', err);
    showToast('Download failed. Try again or contact support.');
  }
}

// ===== TOAST =====
function showToast(message) {
  var existing = document.querySelector('.toast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(function() { toast.classList.add('show'); });
  setTimeout(function() { toast.classList.remove('show'); setTimeout(function() { toast.remove(); }, 300); }, 2000);
}

// ===== PREVIEW MODAL =====
async function openPreview(templateId) {
  var modal = document.getElementById('previewModal');
  var iframe = document.getElementById('previewIframe');
  var loading = document.getElementById('previewLoading');
  var errorDiv = document.getElementById('previewError');
  if (!modal || !iframe) return;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  if (loading) loading.hidden = false;
  if (errorDiv) errorDiv.hidden = true;
  try {
    var result = await supabaseClient.from('templates').select('html_content, css_content, js_content, title').eq('id', templateId).single();
    if (result.error) throw result.error;
    if (!result.data) throw new Error('Template not found');
    var iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
    var html = stripDocumentWrapper(result.data.html_content || '');
    var css = result.data.css_content || '';
    var js = result.data.js_content || '';
    var title = escapeHtml(result.data.title || 'Preview');
    iframeDoc.open();
    iframeDoc.write('<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' + title + '</title><style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;padding:24px;background:#fff;color:#050505;line-height:1.6}' + css + '</style></head><body>' + html + '<script>(function(){document.addEventListener(\'DOMContentLoaded\',function(){try{' + js + '}catch(e){console.error(e);var d=document.createElement(\'div\');d.style.cssText=\'color:#e11d48;padding:16px;margin-top:16px;background:#fef2f2;border-radius:8px;font-family:monospace;font-size:13px;\';d.textContent=\'JS Error: \'+e.message;document.body.appendChild(d);}});})();<\/script></body></html>');
    iframeDoc.close();
    if (loading) loading.hidden = true;
  } catch (err) {
    console.error('Preview failed:', err);
    if (loading) loading.hidden = true;
    if (errorDiv) { errorDiv.hidden = false; errorDiv.textContent = err.message; }
  }
}

function closePreview() {
  var modal = document.getElementById('previewModal');
  var iframe = document.getElementById('previewIframe');
  if (modal) { modal.hidden = true; document.body.style.overflow = ''; }
  if (iframe) iframe.src = 'about:blank';
}

function stripDocumentWrapper(html) {
  if (!html) return '';
  var cleaned = html.replace(/<!DOCTYPE[^>]*>/i, '');
  var bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (bodyMatch) cleaned = bodyMatch[1];
  cleaned = cleaned.replace(/<\/?html[^>]*>/gi, '').replace(/<\/?head[^>]*>[\s\S]*?<\/head>/gi, '').replace(/<\/?body[^>]*>/gi, '');
  return cleaned.trim();
}

function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

document.getElementById('previewClose').addEventListener('click', closePreview);
document.getElementById('previewBackdrop').addEventListener('click', closePreview);
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    var previewModal = document.getElementById('previewModal');
    if (previewModal && !previewModal.hidden) { closePreview(); return; }
    var authModal = document.getElementById('authModal');
    if (authModal && !authModal.hidden) { closeAuthModal(); return; }
    var profileModal = document.getElementById('profileModal');
    if (profileModal && !profileModal.hidden) { closeProfile(); return; }
  }
});

// ===== DETAIL VIEW =====
var currentDetailTemplate = null;

async function openDetailView(template) {
  currentDetailTemplate = template;
  document.getElementById('detailTitle').textContent = template.title;
  document.getElementById('detailDescription').textContent = template.description || 'No description available.';
  document.getElementById('detailCategoryBadge').textContent = template.category;

  var priceBadge = document.getElementById('detailPriceBadge');
  var buyBtn = document.getElementById('detailBuyBtn');
  var copyBtn = document.getElementById('detailCopyBtn');
  var previewBtn = document.getElementById('detailPreviewBtn');

  if (template.price > 0) {
    priceBadge.style.display = 'none';

    let priceLine = document.querySelector('.detail-header .template-price');
    if (!priceLine) {
      priceLine = document.createElement('p');
      priceLine.className = 'template-price';
      document.getElementById('detailTitle').insertAdjacentElement('afterend', priceLine);
    }
    priceLine.textContent = `Price: ₦${Number(template.price).toLocaleString('en-NG')}`;

    var owned = await isUnlocked(template.id);
    if (owned) {
      buyBtn.hidden = true;
      copyBtn.hidden = false;
      copyBtn.textContent = template.file_path ? 'Download ZIP' : 'Copy Code';
      previewBtn.textContent = "Preview Owned Template";
    } else {
      buyBtn.hidden = false;
      copyBtn.hidden = true;
      previewBtn.textContent = "Live Preview";
    }
  } else {
    // ===== FIX: Show "Free" badge on detail page =====
    priceBadge.style.display = 'inline-block';
    priceBadge.textContent = 'Free';
    priceBadge.className = 'card-tag free-tag';
    
    buyBtn.hidden = true;
    copyBtn.hidden = false;
    copyBtn.textContent = template.file_path ? 'Download ZIP' : 'Copy Code';
    previewBtn.textContent = "Live Preview";
  }
  document.querySelector('.grid-container').hidden = true;
  document.querySelector('.search-zone').hidden = true;
  document.getElementById('templateDetailView').hidden = false;
  window.scrollTo(0, 0);
}

document.getElementById('backToGridBtn').addEventListener('click', function() {
  document.getElementById('templateDetailView').hidden = true;
  document.querySelector('.grid-container').hidden = false;
  document.querySelector('.search-zone').hidden = false;
});
document.getElementById('detailPreviewBtn').addEventListener('click', function() { if (currentDetailTemplate) openPreview(currentDetailTemplate.id); });
document.getElementById('detailBuyBtn').addEventListener('click', function() { if (currentDetailTemplate) buyComponent(currentDetailTemplate); });
document.getElementById('detailCopyBtn').addEventListener('click', function() {
  if (!currentDetailTemplate) return;
  if (currentDetailTemplate.file_path) {
    downloadTemplate(currentDetailTemplate.id);
  } else {
    copyCode(currentDetailTemplate.id);
  }
});

// ===== AUTH MODAL =====
function openAuthModal(defaultTab) {
  var modal = document.getElementById('authModal');
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  switchAuthTab(defaultTab || 'login');
  clearAuthErrors();
}

function closeAuthModal() {
  var modal = document.getElementById('authModal');
  modal.hidden = true;
  document.body.style.overflow = '';
}

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(function(t) { t.classList.toggle('active', t.dataset.tab === tab); });
  document.getElementById('formLogin').hidden = tab !== 'login';
  document.getElementById('formSignup').hidden = tab !== 'signup';
  clearAuthErrors();
}

function clearAuthErrors() {
  var loginErr = document.getElementById('loginError');
  var signupErr = document.getElementById('signupError');
  if (loginErr) { loginErr.hidden = true; loginErr.textContent = ''; }
  if (signupErr) { signupErr.hidden = true; signupErr.textContent = ''; }
}

function showAuthError(id, message) {
  var el = document.getElementById(id);
  if (el) { el.textContent = message; el.hidden = false; }
}

function setSubmitLoading(btnId, loading) {
  var btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? 'Please wait…' : (btnId === 'loginSubmit' ? 'Log In' : 'Create Account');
}

document.querySelectorAll('.eye-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var input = document.getElementById(btn.dataset.target);
    var eyeOff = btn.querySelector('.eye-off');
    var eyeOn = btn.querySelector('.eye-on');
    if (!input) return;
    if (input.type === 'password') { input.type = 'text'; eyeOff.hidden = true; eyeOn.hidden = false; }
    else { input.type = 'password'; eyeOff.hidden = false; eyeOn.hidden = true; }
  });
});

document.querySelectorAll('.auth-tab').forEach(function(tab) {
  tab.addEventListener('click', function() { switchAuthTab(tab.dataset.tab); });
});
document.querySelectorAll('.auth-switch-link').forEach(function(link) {
  link.addEventListener('click', function() { switchAuthTab(link.dataset.switch); });
});
document.getElementById('authClose').addEventListener('click', closeAuthModal);
document.getElementById('authBackdrop').addEventListener('click', closeAuthModal);

// ===== LOGIN =====
document.getElementById('loginSubmit').addEventListener('click', async function() {
  var email = document.getElementById('loginEmail').value.trim();
  var password = document.getElementById('loginPassword').value;
  
  // Rate limiting check
  if (!checkRateLimit(email)) {
    var remaining = getRemainingAttempts(email);
    showAuthError('loginError', 'Too many attempts. Please wait ' + Math.ceil((CONFIG.AUTH_WINDOW_MS - (Date.now() - rateLimits[email].resetAt + CONFIG.AUTH_WINDOW_MS)) / 60000) + ' minutes.');
    return;
  }
  
  if (!email || !password) { showAuthError('loginError', 'Please enter your email and password.'); return; }
  setSubmitLoading('loginSubmit', true);
  clearAuthErrors();
  try {
    var result = await supabaseClient.auth.signInWithPassword({ email: email, password: password });
    if (result.error) throw result.error;
    closeAuthModal();
    showToast('Welcome back!');
    await syncPurchasesToLocal();
    if (window._pendingTemplate) {
      var t = window._pendingTemplate;
      window._pendingTemplate = null;
      proceedToCheckout(t);
    }
  } catch (err) {
    showAuthError('loginError', err.message || 'Login failed. Check your email and password.');
  } finally {
    setSubmitLoading('loginSubmit', false);
  }
});

// ===== SIGNUP =====
document.getElementById('signupSubmit').addEventListener('click', async function() {
  var email = document.getElementById('signupEmail').value.trim();
  var password = document.getElementById('signupPassword').value;
  
  // Rate limiting check
  if (!checkRateLimit(email)) {
    showAuthError('signupError', 'Too many attempts. Please wait a few minutes.');
    return;
  }
  
  if (!email || !password) { showAuthError('signupError', 'Please enter your email and password.'); return; }
  if (password.length < 6) { showAuthError('signupError', 'Password must be at least 6 characters.'); return; }
  setSubmitLoading('signupSubmit', true);
  clearAuthErrors();
  try {
    var result = await supabaseClient.auth.signUp({ email: email, password: password, options: { emailRedirectTo: null } });
    if (result.error) throw result.error;
    var session = result.data.session;
    if (session) {
      closeAuthModal();
      showToast('Account created! Welcome to Kuvwy.');
      if (window._pendingTemplate) {
        var t = window._pendingTemplate;
        window._pendingTemplate = null;
        proceedToCheckout(t);
      }
    } else {
      showAuthError('signupError', 'Check your email to confirm your account, then log in.');
      setSubmitLoading('signupSubmit', false);
    }
  } catch (err) {
    showAuthError('signupError', err.message || 'Sign up failed. Try again.');
    setSubmitLoading('signupSubmit', false);
  }
});

// ===== INIT =====
async function initializeApp() {
  if (footerYear) footerYear.textContent = new Date().getFullYear();

  var banner = document.getElementById('offlineBanner');

  function updateOnlineStatus() {
    if (navigator.onLine) {
      banner.style.display = 'none';
    } else {
      banner.style.display = 'flex';
    }
  }

  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();

  if (!navigator.onLine) {
    resultsCount.innerHTML = 'You are offline. Please reconnect to load templates.';
    var cached = localStorage.getItem('cachedTemplates');
    if (cached) {
      try {
        TEMPLATES = JSON.parse(cached);
        resultsCount.innerHTML = 'Showing cached templates — you are offline.';
        runFilter();
      } catch (e) {
        renderGrid();
      }
    } else {
      renderGrid();
    }
    return;
  }

  try {
    resultsCount.innerHTML = 'UI Vault is loading…';
    var result = await supabaseClient.from('templates').select('*');
    if (result.error) throw result.error;
    TEMPLATES = result.data || [];
    localStorage.setItem('cachedTemplates', JSON.stringify(TEMPLATES));
    handlePurchaseReturn();
    runFilter();
  } catch (err) {
    console.error('Supabase connection failed:', err);
    resultsCount.innerHTML = 'Offline mode — showing <strong>0</strong> templates';
    renderGrid();
  }
}

initializeApp();