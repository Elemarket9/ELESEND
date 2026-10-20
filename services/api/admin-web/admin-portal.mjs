/**
 * ELESEND Platform Administration Web Command Center
 * Private, isolated administrative interface.
 * Strictly separate from public customer and courier mobile interfaces.
 * Requires provisioned RFC-6238 TOTP two-factor authentication.
 */

export function renderAdminPortalHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ELESEND Command Center — Platform Administration</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #101827;
      --surface: #1A2438;
      --card: #1F2C44;
      --card-border: #2C3E5E;
      --primary: #18C6A5;
      --primary-dark: #087F69;
      --accent: #FFB547;
      --text: #FFFFFF;
      --text-muted: #94A3B8;
      --danger: #D92D40;
      --success: #18C6A5;
      --line: #26354D;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', -apple-system, sans-serif; }
    body { background-color: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; }
    header { background-color: var(--surface); border-bottom: 1px solid var(--card-border); padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-logo { width: 36px; height: 36px; border-radius: 8px; background: linear-gradient(135deg, var(--primary), var(--primary-dark)); display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 18px; color: #071B28; }
    .brand-title { font-size: 18px; font-weight: 800; letter-spacing: 0.5px; }
    .brand-badge { background: rgba(24, 198, 165, 0.15); color: var(--primary); font-size: 11px; font-weight: 700; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(24, 198, 165, 0.3); }
    .auth-banner { font-size: 13px; color: var(--text-muted); }
    
    .container { max-width: 1200px; margin: 0 auto; padding: 32px 20px; width: 100%; flex: 1; }
    
    /* Login Box */
    .login-container { max-width: 440px; margin: 60px auto; background: var(--surface); border: 1px solid var(--card-border); border-radius: 16px; padding: 32px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .login-header { text-align: center; margin-bottom: 24px; }
    .login-title { font-size: 22px; font-weight: 800; margin-bottom: 8px; }
    .login-desc { font-size: 14px; color: var(--text-muted); line-height: 1.5; }
    .form-group { margin-bottom: 20px; }
    .form-label { display: block; font-size: 13px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
    .form-input { width: 100%; background: var(--bg); border: 1px solid var(--card-border); border-radius: 8px; padding: 12px 14px; color: #fff; font-size: 15px; outline: none; transition: border-color 0.2s; }
    .form-input:focus { border-color: var(--primary); }
    .btn-primary { width: 100%; background: var(--primary); color: #071B28; font-weight: 700; border: none; border-radius: 8px; padding: 14px; font-size: 15px; cursor: pointer; transition: background 0.2s; }
    .btn-primary:hover { background: #15b093; }
    .error-msg { background: rgba(217, 45, 64, 0.15); border: 1px solid var(--danger); color: #ff8b97; padding: 12px; border-radius: 8px; font-size: 13px; margin-bottom: 20px; display: none; }
    
    /* Dashboard Tabs */
    .tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--card-border); margin-bottom: 28px; overflow-x: auto; padding-bottom: 2px; }
    .tab-btn { background: none; border: none; color: var(--text-muted); padding: 12px 18px; font-size: 14px; font-weight: 600; cursor: pointer; border-radius: 8px 8px 0 0; border-bottom: 2px solid transparent; transition: all 0.2s; white-space: nowrap; }
    .tab-btn:hover { color: var(--text); }
    .tab-btn.active { color: var(--primary); border-bottom-color: var(--primary); background: rgba(24, 198, 165, 0.08); }
    
    .panel { display: none; }
    .panel.active { display: block; }
    
    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-bottom: 24px; }
    .card { background: var(--surface); border: 1px solid var(--card-border); border-radius: 12px; padding: 24px; margin-bottom: 20px; }
    .card-title { font-size: 16px; font-weight: 700; margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between; }
    .card-subtitle { font-size: 13px; color: var(--text-muted); margin-bottom: 18px; }
    
    .table-container { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; padding: 12px; background: rgba(0,0,0,0.2); color: var(--text-muted); font-weight: 600; border-bottom: 1px solid var(--card-border); }
    td { padding: 12px; border-bottom: 1px solid var(--card-border); }
    tr:last-child td { border-bottom: none; }
    
    .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 700; }
    .badge-active { background: rgba(24, 198, 165, 0.15); color: var(--primary); }
    .badge-warn { background: rgba(255, 181, 71, 0.15); color: var(--accent); }
    .badge-danger { background: rgba(217, 45, 64, 0.15); color: var(--danger); }
    
    .action-btn { background: var(--card); border: 1px solid var(--card-border); color: #fff; padding: 6px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .action-btn:hover { border-color: var(--primary); color: var(--primary); }
    .action-btn.btn-danger:hover { border-color: var(--danger); color: var(--danger); }
    
    .stat-row { display: flex; gap: 16px; margin-bottom: 20px; }
    .stat-box { flex: 1; background: var(--card); border: 1px solid var(--card-border); border-radius: 8px; padding: 16px; }
    .stat-label { font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase; margin-bottom: 6px; }
    .stat-value { font-size: 22px; font-weight: 800; color: var(--text); }
  </style>
</head>
<body>

  <header>
    <div class="brand">
      <div class="brand-logo">E</div>
      <div>
        <div class="brand-title">ELESEND CONTROL CENTER</div>
        <div style="font-size: 11px; color: var(--text-muted);">Authoritative Operations & Dispatch Administration</div>
      </div>
      <span class="brand-badge">ADMIN PRIVILEGED</span>
    </div>
    <div id="userProfile" class="auth-banner" style="display: none;">
      <span id="adminPhone" style="font-weight: 600;"></span> • <a href="javascript:void(0)" onclick="logout()" style="color: var(--danger); text-decoration: none; margin-left: 8px;">Log out</a>
    </div>
  </header>

  <div class="container">
    <!-- Login Screen -->
    <div id="loginView" class="login-container">
      <div class="login-header">
        <h1 class="login-title">Platform Operator Login</h1>
        <p class="login-desc">Strictly restricted to authorized ELESEND operations personnel. Requires provisioned RFC-6238 TOTP.</p>
      </div>
      <div id="loginError" class="error-msg"></div>
      <form id="loginForm" onsubmit="handleLogin(event)">
        <div class="form-group">
          <label class="form-label">Phone Number</label>
          <input type="tel" id="loginPhone" class="form-input" placeholder="e.g. 024 123 4567" required>
        </div>
        <div class="form-group">
          <label class="form-label">Master Password</label>
          <input type="password" id="loginPassword" class="form-input" placeholder="Enter password" required>
        </div>
        <div class="form-group">
          <label class="form-label">6-Digit Authenticator Code (TOTP)</label>
          <input type="text" id="loginTotp" class="form-input" placeholder="000 000" maxlength="6" pattern="[0-9]{6}" required autocomplete="one-time-code">
        </div>
        <button type="submit" class="btn-primary" id="loginBtn">Authorize Session</button>
      </form>
    </div>

    <!-- Main Dashboard View -->
    <div id="dashboardView" style="display: none;">
      <div class="tabs">
        <button class="tab-btn active" onclick="switchTab('dispatchTab', this)">📡 Dispatch & Algorithms</button>
        <button class="tab-btn" onclick="switchTab('pricingTab', this)">💰 Tariffs & Commission Control</button>
        <button class="tab-btn" onclick="switchTab('fleetTab', this)">🛵 Fleet & Onboarding</button>
        <button class="tab-btn" onclick="switchTab('riskTab', this)">🛡️ Risk Signals & Fraud</button>
        <button class="tab-btn" onclick="switchTab('financeTab', this)">📊 Financial Aging</button>
        <button class="tab-btn" onclick="switchTab('paymentsTab', this)">💳 Payment Methods</button>
      </div>

      <!-- PANEL 1: Dispatch & Algorithms -->
      <div id="dispatchTab" class="panel active">
        <div class="card">
          <div class="card-title">
            <span>Mandatory Core Algorithms</span>
            <button class="action-btn" onclick="loadAlgorithms()">Refresh</button>
          </div>
          <div class="card-subtitle">Active road corridor, adaptive GPS filtering, and spatial dispatch features.</div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Algorithm Feature</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="algorithmsTable">
                <tr><td colspan="3" style="text-align: center; color: var(--text-muted);">Loading algorithm features...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Active Dispatch Policy</div>
          <div class="card-subtitle">Server-authoritative matching and offer window parameters.</div>
          <div id="policyParams" class="grid-2">
            <div><span style="color:var(--text-muted)">Loading policy...</span></div>
          </div>
        </div>
      </div>

      <!-- PANEL 2: Pricing & Commission -->
      <div id="pricingTab" class="panel">
        <div class="card">
          <div class="card-title">
            <span>Dynamic Vehicle Pricing & Tariffs</span>
            <button class="action-btn" onclick="loadPricing()">Refresh Tariffs</button>
          </div>
          <div class="card-subtitle">Unbeatable driver net rates vs Bolt & Yango. Platform fee standard: 13.0% (1,300 bps, max 20.0%).</div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>Base Fare</th>
                  <th>Per-Km Fare</th>
                  <th>Per-Min</th>
                  <th>Commission</th>
                  <th>Rush Hour</th>
                </tr>
              </thead>
              <tbody id="pricingTable">
                <tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Loading pricing...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Configure Global Platform Commission</div>
          <div class="card-subtitle">Update commission take-rate with immutable policy versioning.</div>
          <form onsubmit="handleCommissionUpdate(event)" style="display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end;">
            <div style="flex: 1; min-width: 140px;">
              <label class="form-label">Vehicle Scope</label>
              <select id="commVehicle" class="form-input">
                <option value="">All Vehicles</option>
                <option value="motorcycle">Motorcycle</option>
                <option value="car">Car</option>
                <option value="van">Van</option>
              </select>
            </div>
            <div style="flex: 1; min-width: 140px;">
              <label class="form-label">Commission %</label>
              <input type="number" id="commPercent" class="form-input" value="13.0" step="0.01" min="0" max="100" required>
            </div>
            <div style="flex: 1; min-width: 140px;">
              <label class="form-label">Mode</label>
              <select id="commMode" class="form-input">
                <option value="percentage">Percentage</option>
                <option value="fixed">Fixed Pesewas</option>
                <option value="hybrid">Hybrid (Rate + Cap)</option>
              </select>
            </div>
            <div style="flex: 1; min-width: 140px;">
              <label class="form-label">Cap (GH₵, optional)</label>
              <input type="number" id="commCap" class="form-input" placeholder="e.g. 15.00" step="0.5">
            </div>
            <button type="submit" class="btn-primary" style="width: auto; padding: 12px 24px;">Apply Policy</button>
          </form>
        </div>

        <div class="card">
          <div class="card-title">
            <span>Dynamic Commission Rules & Promotional Campaigns</span>
            <button class="action-btn" onclick="loadCommissionRules()">Refresh Rules</button>
          </div>
          <div class="card-subtitle">Zero percent (0%) founding campaigns, merchant contracts, and dynamic rate precedence.</div>
          
          <div class="table-container" style="margin-bottom: 20px;">
            <table>
              <thead>
                <tr>
                  <th>Rule Name</th>
                  <th>Category</th>
                  <th>Scope</th>
                  <th>Rate</th>
                  <th>Orders</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="commissionRulesTable">
                <tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Loading commission rules...</td></tr>
              </tbody>
            </table>
          </div>

          <div style="border-top: 1px solid var(--border-color); padding-top: 16px;">
            <div style="font-weight: 600; margin-bottom: 12px; font-size: 14px;">Create Custom Commission Rule / Campaign</div>
            <form onsubmit="handleCreateCommissionRule(event)" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; align-items: flex-end;">
              <div>
                <label class="form-label">Rule Name</label>
                <input type="text" id="ruleName" class="form-input" placeholder="e.g. Founding Rider Accra" required>
              </div>
              <div>
                <label class="form-label">Category</label>
                <select id="ruleCategory" class="form-input">
                  <option value="founding_rider">Founding Rider (0%)</option>
                  <option value="promotional_campaign">Promotional Campaign</option>
                  <option value="rider_delivery">Rider Agreement</option>
                  <option value="merchant_delivery">Merchant Delivery</option>
                  <option value="restaurant_food">Restaurant Food Sales</option>
                  <option value="corporate_delivery">Corporate Account</option>
                </select>
              </div>
              <div>
                <label class="form-label">Scope</label>
                <select id="ruleScopeType" class="form-input">
                  <option value="rider">Rider Specific</option>
                  <option value="merchant">Merchant Specific</option>
                  <option value="restaurant">Restaurant Specific</option>
                  <option value="campaign">Global Campaign</option>
                </select>
              </div>
              <div>
                <label class="form-label">Scope ID (User/Rest ID)</label>
                <input type="text" id="ruleScopeId" class="form-input" placeholder="Optional User/Entity UUID">
              </div>
              <div>
                <label class="form-label">Rate % (0.00 - 100.00)</label>
                <input type="number" id="ruleRatePercent" class="form-input" value="0.0" step="0.01" min="0" max="100" oninput="checkRateWarning()" required>
              </div>
              <div>
                <label class="form-label">Max Orders</label>
                <input type="number" id="ruleMaxOrders" class="form-input" placeholder="e.g. 100" min="1">
              </div>
              <div style="grid-column: 1 / -1;">
                <label class="form-label">Audit Reason / Commercial Rationale</label>
                <input type="text" id="ruleReason" class="form-input" placeholder="Document commercial rationale for this commission rate" required minlength="5">
              </div>
              <div id="highRateWarningGroup" style="grid-column: 1 / -1; display: none; background: rgba(239, 68, 68, 0.1); border: 1px solid var(--danger-color); border-radius: 8px; padding: 12px;">
                <label style="display: flex; align-items: center; gap: 8px; font-weight: 600; color: #fca5a5; font-size: 13px;">
                  <input type="checkbox" id="confirmHighRate"> Confirm High Commission Rate (> 20.00%)
                </label>
                <input type="text" id="highRateRationale" class="form-input" style="margin-top: 8px;" placeholder="Mandatory executive rationale for high commission (>10 characters)">
              </div>
              <div>
                <button type="submit" class="btn-primary" style="width: auto; padding: 12px 24px;">Create Rule</button>
              </div>
            </form>
          </div>
        </div>
      </div>

      <!-- PANEL 3: Fleet & Onboarding -->
      <div id="fleetTab" class="panel">
        <div class="card">
          <div class="card-title">
            <span>Pending Courier Approvals</span>
            <button class="action-btn" onclick="loadFleet()">Refresh Queue</button>
          </div>
          <div class="card-subtitle">Review driver identity and vehicle registration documents before operational dispatch.</div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Phone</th>
                  <th>Role</th>
                  <th>Vehicle</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="fleetTable">
                <tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No pending reviews.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- PANEL 4: Risk Signals & Fraud -->
      <div id="riskTab" class="panel">
        <div class="card">
          <div class="card-title">
            <span>Explainable Risk Signals</span>
            <button class="action-btn" onclick="loadRisk()">Refresh Signals</button>
          </div>
          <div class="card-subtitle">Anomalous GPS speed, OTP brute force flags, and suspicious refund triggers. (Never auto-punishes).</div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Signal ID</th>
                  <th>Rider / User</th>
                  <th>Flag Type</th>
                  <th>Details</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="riskTable">
                <tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No active risk signals detected.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- PANEL 5: Financial Aging -->
      <div id="financeTab" class="panel">
        <div class="card">
          <div class="card-title">
            <span>Rider Commission Receivables Aging</span>
            <button class="action-btn" onclick="loadFinance()">Refresh Aging</button>
          </div>
          <div class="card-subtitle">Tracks accrued delivery platform commission from completed cash trips awaiting MoMo settlement.</div>
          <div id="agingStats" class="stat-row">
            <div class="stat-box"><div class="stat-label">Current Due (0-7 Days)</div><div class="stat-value" id="agingCurrent">GH₵0.00</div></div>
            <div class="stat-box"><div class="stat-label">Overdue (8-14 Days)</div><div class="stat-value" id="agingOverdue" style="color:var(--accent);">GH₵0.00</div></div>
            <div class="stat-box"><div class="stat-label">Critical (>14 Days)</div><div class="stat-value" id="agingCritical" style="color:var(--danger);">GH₵0.00</div></div>
          </div>
        </div>
      </div>

      <!-- PANEL 6: Payment Methods -->
      <div id="paymentsTab" class="panel">
        <div class="card">
          <div class="card-title">
            <span>Supported Payment Channels</span>
            <button class="action-btn" onclick="loadPaymentMethods()">Refresh</button>
          </div>
          <div class="card-subtitle">Toggle Cash, Mobile Money (MTN, Telecel, AT), and Card payments platform-wide.</div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Description</th>
                  <th>Status</th>
                  <th>Toggle</th>
                </tr>
              </thead>
              <tbody id="paymentsTable">
                <tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Loading payment methods...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

    </div>
  </div>

  <script>
    let token = localStorage.getItem('elesend_admin_token') || '';
    
    function api(path, options = {}) {
      return fetch(path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
          ...(options.headers || {})
        }
      }).then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'Server error ' + r.status);
        return data;
      });
    }

    function ghc(minor) {
      return 'GH₵' + (Number(minor || 0) / 100).toFixed(2);
    }

    async function checkAuth() {
      if (!token) {
        showLogin();
        return;
      }
      try {
        const me = await api('/api/v1/me');
        if (me.kind !== 'admin') {
          throw new Error('Access denied: not an administrator account');
        }
        showDashboard(me);
      } catch (e) {
        token = '';
        localStorage.removeItem('elesend_admin_token');
        showLogin();
      }
    }

    function showLogin() {
      document.getElementById('loginView').style.display = 'block';
      document.getElementById('dashboardView').style.display = 'none';
      document.getElementById('userProfile').style.display = 'none';
    }

    function showDashboard(user) {
      document.getElementById('loginView').style.display = 'none';
      document.getElementById('dashboardView').style.display = 'block';
      document.getElementById('userProfile').style.display = 'block';
      document.getElementById('adminPhone').textContent = user.phone || 'Administrator';
      loadAlgorithms();
    }

    async function handleLogin(e) {
      e.preventDefault();
      const errBox = document.getElementById('loginError');
      errBox.style.display = 'none';
      const phone = document.getElementById('loginPhone').value.trim();
      const password = document.getElementById('loginPassword').value;
      const totpCode = document.getElementById('loginTotp').value.trim();
      
      try {
        const res = await api('/api/v1/auth/login', {
          method: 'POST',
          body: JSON.stringify({ phone, password, totpCode })
        });
        token = res.token;
        localStorage.setItem('elesend_admin_token', token);
        await checkAuth();
      } catch (err) {
        errBox.textContent = '⚠️ ' + err.message;
        errBox.style.display = 'block';
      }
    }

    async function logout() {
      try { await api('/api/v1/auth/logout', { method: 'POST' }); } catch {}
      token = '';
      localStorage.removeItem('elesend_admin_token');
      showLogin();
    }

    function switchTab(tabId, el) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      el.classList.add('active');
      document.getElementById(tabId).classList.add('active');

      if (tabId === 'dispatchTab') loadAlgorithms();
      if (tabId === 'pricingTab') { loadPricing(); loadCommissionRules(); }
      if (tabId === 'fleetTab') loadFleet();
      if (tabId === 'riskTab') loadRisk();
      if (tabId === 'financeTab') loadFinance();
      if (tabId === 'paymentsTab') loadPaymentMethods();
    }

    async function loadAlgorithms() {
      try {
        const algos = await api('/api/v1/admin/algorithm-features');
        const tb = document.getElementById('algorithmsTable');
        tb.innerHTML = algos.map(a => \`
          <tr>
            <td><strong>\${a.feature_key.replaceAll('_', ' ').toUpperCase()}</strong></td>
            <td><span class="badge \${a.enabled ? 'badge-active' : 'badge-danger'}">\${a.enabled ? 'ENABLED' : 'DISABLED'}</span></td>
            <td>
              <button class="action-btn" onclick="toggleAlgorithm('\${a.feature_key}', \${!a.enabled})">\${a.enabled ? 'Disable' : 'Enable'}</button>
            </td>
          </tr>
        \`).join('');

        const policy = await api('/api/v1/admin/dispatch-policy');
        const pBox = document.getElementById('policyParams');
        pBox.innerHTML = \`
          <div class="card" style="margin-bottom:0;">
            <div class="stat-label">Search Radius</div>
            <div class="stat-value">\${policy.search_radii_m?.[0] || 5000} m</div>
          </div>
          <div class="card" style="margin-bottom:0;">
            <div class="stat-label">Max Active Parcels</div>
            <div class="stat-value">\${policy.max_active_parcels || 2}</div>
          </div>
        \`;
      } catch (e) {
        console.error(e);
      }
    }

    async function toggleAlgorithm(key, enabled) {
      try {
        await api('/api/v1/admin/algorithm-features', {
          method: 'POST',
          body: JSON.stringify({ featureKey: key, enabled })
        });
        loadAlgorithms();
      } catch (e) {
        alert(e.message);
      }
    }

    async function loadPricing() {
      try {
        const tariffs = await api('/api/v1/admin/pricing');
        const tb = document.getElementById('pricingTable');
        tb.innerHTML = tariffs.map(t => \`
          <tr>
            <td><strong>\${(t.vehicle || 'STANDARD').toUpperCase()}</strong></td>
            <td>\${ghc(t.base_minor)}</td>
            <td>\${ghc(t.per_km_minor)}</td>
            <td>\${ghc(t.per_minute_minor || 0)}</td>
            <td><span class="badge badge-active">\${(t.commission_bps / 100).toFixed(1)}% (\${t.commission_mode || 'pct'})</span></td>
            <td>\${t.rush_hour_enabled ? 'Active ⚡' : 'Off'}</td>
          </tr>
        \`).join('');
      } catch (e) {
        console.error(e);
      }
    }

    async function handleCommissionUpdate(e) {
      e.preventDefault();
      const vehicle = document.getElementById('commVehicle').value || null;
      const pct = parseFloat(document.getElementById('commPercent').value);
      const mode = document.getElementById('commMode').value;
      const cap = document.getElementById('commCap').value;
      const bps = Math.round(pct * 100);
      const capMinor = cap ? Math.round(parseFloat(cap) * 100) : null;

      try {
        await api('/api/v1/admin/pricing/commission', {
          method: 'POST',
          body: JSON.stringify({ vehicle, commissionBps: bps, commissionMode: mode, commissionCapMinor: capMinor })
        });
        alert('Commission policy updated successfully.');
        loadPricing();
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    function checkRateWarning() {
      const val = parseFloat(document.getElementById('ruleRatePercent').value || 0);
      const grp = document.getElementById('highRateWarningGroup');
      if (val > 20.0) {
        grp.style.display = 'block';
      } else {
        grp.style.display = 'none';
        document.getElementById('confirmHighRate').checked = false;
      }
    }

    async function loadCommissionRules() {
      try {
        const rules = await api('/api/v1/admin/commission/rules');
        const tb = document.getElementById('commissionRulesTable');
        if (!rules || rules.length === 0) {
          tb.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 16px;">No custom commission rules active. System defaults apply (13% delivery, 10% food).</td></tr>';
          return;
        }
        tb.innerHTML = rules.map(r => \`
          <tr>
            <td><strong>\${r.name}</strong><br><small style="color:var(--text-muted);">\${r.reason || ''}</small></td>
            <td><span class="badge badge-active">\${r.category.replaceAll('_', ' ').toUpperCase()}</span></td>
            <td>\${r.scope_type.toUpperCase()}\${r.scope_id ? '<br><small>' + r.scope_id.substring(0,8) + '...</small>' : ''}</td>
            <td><strong>\${r.ratePercent}</strong></td>
            <td>\${r.applied_orders}\${r.max_orders ? ' / ' + r.max_orders : ''}</td>
            <td><span class="badge \${r.status === 'active' ? 'badge-active' : r.status === 'paused' ? 'badge-warning' : 'badge-danger'}">\${r.status.toUpperCase()}</span></td>
            <td>
              \${r.status === 'active' ? \`<button class="action-btn" onclick="pauseCommissionRule('\${r.id}')">Pause</button>\` : ''}
              \${r.status === 'paused' ? \`<button class="action-btn" onclick="resumeCommissionRule('\${r.id}')">Resume</button>\` : ''}
              \${r.status !== 'revoked' ? \`<button class="action-btn" style="color:var(--danger-color);" onclick="revokeCommissionRule('\${r.id}')">Revoke</button>\` : ''}
            </td>
          </tr>
        \`).join('');
      } catch (e) {
        console.error(e);
      }
    }

    async function handleCreateCommissionRule(e) {
      e.preventDefault();
      const name = document.getElementById('ruleName').value.trim();
      const category = document.getElementById('ruleCategory').value;
      const scopeType = document.getElementById('ruleScopeType').value;
      const scopeId = document.getElementById('ruleScopeId').value.trim() || null;
      const ratePct = parseFloat(document.getElementById('ruleRatePercent').value);
      const maxOrdersVal = document.getElementById('ruleMaxOrders').value;
      const maxOrders = maxOrdersVal ? parseInt(maxOrdersVal, 10) : null;
      const reason = document.getElementById('ruleReason').value.trim();
      const confirmHighRate = document.getElementById('confirmHighRate').checked;
      const highRateRationale = document.getElementById('highRateRationale').value.trim();
      const rateBps = Math.round(ratePct * 100);

      try {
        await api('/api/v1/admin/commission/rules', {
          method: 'POST',
          body: JSON.stringify({
            name,
            category,
            scopeType,
            scopeId,
            rateBps,
            maxOrders,
            reason,
            confirmHighRate,
            highRateRationale: confirmHighRate ? highRateRationale : undefined
          })
        });
        alert('Commission rule created successfully!');
        document.getElementById('ruleName').value = '';
        document.getElementById('ruleScopeId').value = '';
        document.getElementById('ruleReason').value = '';
        document.getElementById('ruleMaxOrders').value = '';
        loadCommissionRules();
      } catch (err) {
        alert('Failed to create rule: ' + err.message);
      }
    }

    async function pauseCommissionRule(id) {
      const rationale = prompt('Commercial rationale for pausing this rule:');
      if (!rationale) return;
      try {
        await api(\`/api/v1/admin/commission/rules/\${id}/pause\`, {
          method: 'POST',
          body: JSON.stringify({ rationale })
        });
        loadCommissionRules();
      } catch (err) {
        alert(err.message);
      }
    }

    async function resumeCommissionRule(id) {
      const rationale = prompt('Commercial rationale for resuming this rule:');
      if (!rationale) return;
      try {
        await api(\`/api/v1/admin/commission/rules/\${id}/resume\`, {
          method: 'POST',
          body: JSON.stringify({ rationale })
        });
        loadCommissionRules();
      } catch (err) {
        alert(err.message);
      }
    }

    async function revokeCommissionRule(id) {
      const rationale = prompt('Commercial rationale for revoking this rule permanently:');
      if (!rationale) return;
      try {
        await api(\`/api/v1/admin/commission/rules/\${id}/revoke\`, {
          method: 'POST',
          body: JSON.stringify({ rationale })
        });
        loadCommissionRules();
      } catch (err) {
        alert(err.message);
      }
    }

    async function loadFleet() {
      try {
        const queue = await api('/api/v1/admin/review');
        const tb = document.getElementById('fleetTable');
        if (!queue?.riders?.length && !queue?.companies?.length) {
          tb.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 24px;">No pending onboarding reviews in queue.</td></tr>';
          return;
        }
        tb.innerHTML = (queue.riders || []).map(r => \`
          <tr>
            <td>\${r.phone}</td>
            <td>COURIER</td>
            <td>\${r.vehicle || 'motorcycle'}</td>
            <td><span class="badge badge-warn">\${r.status.toUpperCase()}</span></td>
            <td>
              <button class="action-btn" onclick="reviewRider('\${r.id}', 'approved')">Approve</button>
              <button class="action-btn btn-danger" onclick="reviewRider('\${r.id}', 'suspended')">Reject</button>
            </td>
          </tr>
        \`).join('');
      } catch (e) {
        console.error(e);
      }
    }

    async function reviewRider(id, status) {
      try {
        await api(\`/api/v1/admin/riders/\${id}\`, {
          method: 'POST',
          body: JSON.stringify({ status })
        });
        loadFleet();
      } catch (e) {
        alert(e.message);
      }
    }

    async function loadRisk() {
      try {
        const signals = await api('/api/v1/admin/risk-signals');
        const tb = document.getElementById('riskTable');
        if (!signals?.length) {
          tb.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 24px;">No risk signals currently flagged.</td></tr>';
          return;
        }
        tb.innerHTML = signals.map(s => \`
          <tr>
            <td><code>\${s.id.slice(0,8)}</code></td>
            <td>\${s.rider_id ? s.rider_id.slice(0,8) : 'N/A'}</td>
            <td><span class="badge badge-danger">\${s.signal_type}</span></td>
            <td>\${s.description || 'Automated rule match'}</td>
            <td>\${s.reviewed ? 'REVIEWED' : 'PENDING'}</td>
            <td>
              \${!s.reviewed ? \`<button class="action-btn" onclick="reviewRisk('\${s.id}')">Dismiss / Resolve</button>\` : 'Done'}
            </td>
          </tr>
        \`).join('');
      } catch (e) {
        console.error(e);
      }
    }

    async function reviewRisk(id) {
      try {
        await api('/api/v1/admin/risk-signals/review', {
          method: 'POST',
          body: JSON.stringify({ signalId: id, decision: 'reviewed', notes: 'Operator manual inspection verified.' })
        });
        loadRisk();
      } catch (e) {
        alert(e.message);
      }
    }

    async function loadFinance() {
      try {
        const aging = await api('/api/v1/admin/finance/aging');
        document.getElementById('agingCurrent').textContent = ghc(aging?.currentMinor || 0);
        document.getElementById('agingOverdue').textContent = ghc(aging?.overdueMinor || 0);
        document.getElementById('agingCritical').textContent = ghc(aging?.criticalMinor || 0);
      } catch (e) {
        console.error(e);
      }
    }

    async function loadPaymentMethods() {
      try {
        const methods = await api('/api/v1/admin/payments/methods');
        const tb = document.getElementById('paymentsTable');
        tb.innerHTML = methods.map(m => \`
          <tr>
            <td><strong>\${m.method}</strong></td>
            <td>\${m.method === 'CASH' ? 'Cash at pickup or drop-off' : m.method === 'MOMO' ? 'Mobile Money (MTN, Telecel, AT)' : m.method === 'CARD' ? 'Debit / Credit Card (Hosted)' : 'Scan & Pay QR'}</td>
            <td><span class="badge \${m.enabled ? 'badge-active' : 'badge-danger'}">\${m.enabled ? 'ACTIVE' : 'DISABLED'}</span></td>
            <td>
              <button class="action-btn" onclick="togglePaymentMethod('\${m.method}', \${!m.enabled})">\${m.enabled ? 'Disable' : 'Enable'}</button>
            </td>
          </tr>
        \`).join('');
      } catch (e) {
        console.error(e);
      }
    }

    async function togglePaymentMethod(method, enabled) {
      try {
        await api('/api/v1/admin/payments/methods', {
          method: 'POST',
          body: JSON.stringify({ method, enabled })
        });
        loadPaymentMethods();
      } catch (e) {
        alert(e.message);
      }
    }

    // Initialize
    checkAuth();
  </script>
</body>
</html>`;
}
