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
        <button class="tab-btn" onclick="switchTab('promotionsTab', this)">🎁 Restaurant Commissions & Promos</button>
        <button class="tab-btn" onclick="switchTab('supportChatTab', this)">💬 Support Chat & Moderation</button>
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

      <!-- PANEL 5: Financial Aging, Payouts, Refunds & Exceptions -->
      <div id="financeTab" class="panel">
        <div class="card">
          <div class="card-title">
            <span>Rider Wallet & Debt Recovery Governance</span>
            <button class="action-btn" onclick="loadFinance()">Refresh Overview</button>
          </div>
          <div class="card-subtitle">Real-time ledger projection of rider commission debt, automatic earnings recovery, and dispatch gating.</div>
          <div class="stat-row">
            <div class="stat-box"><div class="stat-label">Active Debt Owed</div><div class="stat-value" id="walletTotalDebt" style="color:var(--danger);">GH₵0.00</div></div>
            <div class="stat-box"><div class="stat-label">Restricted Riders</div><div class="stat-value" id="walletRestrictedRiders" style="color:var(--accent);">0</div></div>
            <div class="stat-box"><div class="stat-label">Auto-Recovered Total</div><div class="stat-value" id="walletTotalRecovered" style="color:var(--success);">GH₵0.00</div></div>
            <div class="stat-box"><div class="stat-label">Policy Debt Limit</div><div class="stat-value" id="walletPolicyLimit">GH₵150.00</div></div>
          </div>
          <div style="display: flex; gap: 12px; align-items: center; margin-top: 12px;">
            <button class="action-btn" onclick="runWalletReconciliation()">Run Ledger Reconciliation</button>
            <span id="reconciliationNotice" style="font-size: 12px; color: var(--text-muted);"></span>
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>Rider Commission Receivables Aging</span>
            <button class="action-btn" onclick="loadFinance()">Refresh Finance</button>
          </div>
          <div class="card-subtitle">Tracks accrued delivery platform commission from completed cash trips awaiting MoMo settlement.</div>
          <div id="agingStats" class="stat-row">
            <div class="stat-box"><div class="stat-label">Current Due (0-7 Days)</div><div class="stat-value" id="agingCurrent">GH₵0.00</div></div>
            <div class="stat-box"><div class="stat-label">Overdue (8-14 Days)</div><div class="stat-value" id="agingOverdue" style="color:var(--accent);">GH₵0.00</div></div>
            <div class="stat-box"><div class="stat-label">Critical (>14 Days)</div><div class="stat-value" id="agingCritical" style="color:var(--danger);">GH₵0.00</div></div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>Payout Operations (Two-Person Approval)</span>
            <button class="action-btn" onclick="loadFinance()">Refresh Payouts</button>
          </div>
          <div class="card-subtitle">Propose, approve (requires second finance admin), reconcile, and safely retry failed rider/company/restaurant payouts.</div>
          <form onsubmit="handleProposePayout(event)" style="display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 16px;">
            <div style="flex: 2; min-width: 220px;">
              <label class="form-label">Shipment ID</label>
              <input type="text" id="proposeShipmentId" class="form-input" placeholder="Completed Shipment UUID" required>
            </div>
            <div style="flex: 1; min-width: 150px;">
              <label class="form-label">Beneficiary Kind</label>
              <select id="proposePayoutKind" class="form-input">
                <option value="rider">Rider / Fleet Company</option>
                <option value="restaurant">Restaurant Merchant</option>
              </select>
            </div>
            <button type="submit" class="btn-primary" style="width: auto; padding: 12px 20px;">Propose Payout</button>
          </form>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Payout ID</th>
                  <th>Shipment / Kind</th>
                  <th>Beneficiary / Destination</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="payoutsTable">
                <tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Loading payout operations...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>Refund Operations & Exceptions</span>
            <button class="action-btn" onclick="loadFinance()">Refresh Refunds</button>
          </div>
          <div class="card-subtitle">Submit pending customer refunds, reconcile uncertain provider calls, and retry verified failed refunds.</div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Refund ID</th>
                  <th>Shipment</th>
                  <th>Reference</th>
                  <th>Amount</th>
                  <th>Status / Reason</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="refundsTable">
                <tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Loading refund operations...</td></tr>
              </tbody>
            </table>
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

      <!-- PANEL 7: Restaurant Commissions & Promotions -->
      <div id="promotionsTab" class="panel">
        <div class="grid-2">
          <div class="card" style="margin-bottom:0;">
            <div class="card-title">
              <span>Global Restaurant Commission Policy</span>
              <button class="action-btn" onclick="loadPromotionsTab()">Refresh</button>
            </div>
            <div class="card-subtitle">Default 10.0% (1,000 bps) food commission & deterministic calculation basis.</div>
            <form onsubmit="handleSaveRestaurantCommissionSettings(event)">
              <div class="form-group">
                <label class="form-label">Default Restaurant Commission %</label>
                <input type="number" id="restDefaultCommPct" class="form-input" value="10.0" step="0.1" min="0" max="30" required>
              </div>
              <div class="form-group">
                <label class="form-label">Default Calculation Basis</label>
                <select id="restDefaultCommBasis" class="form-input">
                  <option value="gross_subtotal">Gross Food Subtotal (Platform Default)</option>
                  <option value="net_after_restaurant_discount">Net After Restaurant-Funded Discount</option>
                  <option value="net_after_all_discounts">Net After All Discounts</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Operator Rationale</label>
                <input type="text" id="restCommRationale" class="form-input" placeholder="Reason for policy update" required>
              </div>
              <button type="submit" class="btn-primary">Update Global Restaurant Commission</button>
            </form>
          </div>

          <div class="card" style="margin-bottom:0;">
            <div class="card-title">Merchant-Specific Commission Agreement</div>
            <div class="card-subtitle">Assign custom contract rate, partner tier, or commission basis per restaurant.</div>
            <form onsubmit="handleSaveRestaurantAgreement(event)">
              <div class="form-group">
                <label class="form-label">Restaurant UUID</label>
                <input type="text" id="agreeRestId" class="form-input" placeholder="Restaurant ID" required>
              </div>
              <div class="grid-2" style="margin-bottom:12px;">
                <div>
                  <label class="form-label">Custom Rate %</label>
                  <input type="number" id="agreeRatePct" class="form-input" placeholder="e.g. 8.0" step="0.1" min="0" max="30">
                </div>
                <div>
                  <label class="form-label">Partner Tier</label>
                  <select id="agreeTier" class="form-input">
                    <option value="standard">Standard</option>
                    <option value="founding">Founding Partner</option>
                    <option value="strategic">Strategic Partner</option>
                    <option value="enterprise">Enterprise</option>
                  </select>
                </div>
              </div>
              <div class="form-group">
                <label class="form-label">Calculation Basis Override</label>
                <select id="agreeBasis" class="form-input">
                  <option value="">Use Global Default</option>
                  <option value="gross_subtotal">Gross Food Subtotal</option>
                  <option value="net_after_restaurant_discount">Net After Restaurant Discount</option>
                  <option value="net_after_all_discounts">Net After All Discounts</option>
                </select>
              </div>
              <div class="form-group">
                <label class="form-label">Contract Notes / Justification</label>
                <input type="text" id="agreeNotes" class="form-input" placeholder="Commercial contract reference" required>
              </div>
              <button type="submit" class="btn-primary">Save Merchant Agreement</button>
            </form>
          </div>
        </div>

        <div class="card">
          <div class="card-title">
            <span>Create ELESEND-Funded or Joint Co-Funded Promotion Campaign</span>
          </div>
          <div class="card-subtitle">ELESEND-funded subsidies never reduce restaurant payout or rider earnings. Joint campaigns require explicit merchant opt-in consent.</div>
          <form onsubmit="handleCreateAdminPromotion(event)" style="display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px;">
            <div>
              <label class="form-label">Campaign Name</label>
              <input type="text" id="promoName" class="form-input" placeholder="e.g. Accra Food Fest 20%" required>
            </div>
            <div>
              <label class="form-label">Funding Source</label>
              <select id="promoOwnerType" class="form-input">
                <option value="elesend">ELESEND Platform-Funded (100%)</option>
                <option value="joint">Joint Co-Funded Partnership</option>
              </select>
            </div>
            <div>
              <label class="form-label">Discount Type</label>
              <select id="promoDiscountType" class="form-input">
                <option value="percentage_off">Percentage Off (%)</option>
                <option value="fixed_amount_off">Fixed Amount Off (GH₵)</option>
                <option value="free_delivery">Free Delivery</option>
                <option value="discounted_delivery">Discounted Delivery</option>
              </select>
            </div>
            <div>
              <label class="form-label">Value (% or GH₵)</label>
              <input type="number" id="promoValue" class="form-input" value="15" step="0.5" min="0" required>
            </div>
            <div>
              <label class="form-label">Promo Code (optional)</label>
              <input type="text" id="promoCode" class="form-input" placeholder="e.g. ELESEND15">
            </div>
            <div>
              <label class="form-label">Total Budget Cap (GH₵)</label>
              <input type="number" id="promoBudgetGhc" class="form-input" value="1000" step="10" min="1">
            </div>
            <div>
              <label class="form-label">Restaurant Share % (Joint)</label>
              <input type="number" id="promoRestSharePct" class="form-input" value="0" min="0" max="100">
            </div>
            <div>
              <label class="form-label">Commission Concession %</label>
              <input type="number" id="promoCommConcessionPct" class="form-input" value="0" min="0" max="10" step="0.5">
            </div>
            <div style="display:flex; align-items:flex-end;">
              <button type="submit" class="btn-primary">Launch Campaign</button>
            </div>
          </form>
        </div>

        <div class="card">
          <div class="card-title">
            <span>Active & Scheduled Promotion Campaigns</span>
            <button class="action-btn" onclick="loadPromotionsTab()">Refresh Campaigns</button>
          </div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Owner / Split</th>
                  <th>Discount</th>
                  <th>Budget Used</th>
                  <th>Redemptions</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="adminPromotionsTable">
                <tr><td colspan="7" style="text-align:center; color:var(--text-muted);">Loading campaigns...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- PANEL 8: Support Chat & Safety Moderation -->
      <div id="supportChatTab" class="panel">
        <div class="grid-2">
          <div class="card" style="margin-bottom:0;">
            <div class="card-title">
              <span>Escalated Customer Support Conversations</span>
              <button class="action-btn" onclick="loadSupportChatTab()">Refresh Queue</button>
            </div>
            <div class="card-subtitle">Order-scoped support escalations. Inspecting non-support threads requires an audited justification.</div>
            <div class="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Conversation</th>
                    <th>Category / Order</th>
                    <th>State</th>
                    <th>Last Message</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody id="supportConversationsTable">
                  <tr><td colspan="5" style="text-align:center; color:var(--text-muted);">Loading support queue...</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="card" style="margin-bottom:0;">
            <div class="card-title">
              <span>Chat Abuse & Safety Reports</span>
            </div>
            <div class="card-subtitle">Reported messages & participants. Moderate with mandatory resolution notes.</div>
            <div class="table-container">
              <table>
                <thead>
                  <tr>
                    <th>Report</th>
                    <th>Category</th>
                    <th>Reported Message / Details</th>
                    <th>Status</th>
                    <th>Moderate</th>
                  </tr>
                </thead>
                <tbody id="abuseReportsTable">
                  <tr><td colspan="5" style="text-align:center; color:var(--text-muted);">Loading abuse reports...</td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="card" id="supportInspectorCard" style="display:none; margin-top:20px;">
          <div class="card-title">
            <span id="supportInspectorTitle">Support Thread Inspector</span>
            <button class="action-btn" onclick="document.getElementById('supportInspectorCard').style.display='none'">Close</button>
          </div>
          <div id="supportInspectorMessages" style="max-height:280px; overflow-y:auto; background:var(--bg); border:1px solid var(--card-border); border-radius:8px; padding:12px; margin-bottom:12px;"></div>
          <form onsubmit="handleSendSupportMessage(event)" style="display:flex; gap:10px;">
            <input type="hidden" id="supportActiveConvId">
            <input type="text" id="supportReplyInput" class="form-input" placeholder="Type official ELESEND Support response..." required>
            <button type="submit" class="btn-primary" style="width:auto; padding:12px 20px;">Send Reply</button>
          </form>
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

    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
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

    let currentAdmin = null;

    function showDashboard(user) {
      currentAdmin = user;
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
      if (tabId === 'promotionsTab') loadPromotionsTab();
      if (tabId === 'supportChatTab') loadSupportChatTab();
    }

    async function loadAlgorithms() {
      try {
        const algos = await api('/api/v1/admin/algorithm-features');
        const tb = document.getElementById('algorithmsTable');
        tb.innerHTML = algos.map(a => \`
          <tr>
            <td><strong>\${escapeHtml(a.feature_key.replaceAll('_', ' ').toUpperCase())}</strong></td>
            <td><span class="badge \${a.enabled ? 'badge-active' : 'badge-danger'}">\${a.enabled ? 'ENABLED' : 'DISABLED'}</span></td>
            <td>
              <button class="action-btn" onclick="toggleAlgorithm('\${escapeHtml(a.feature_key)}', \${!a.enabled})">\${a.enabled ? 'Disable' : 'Enable'}</button>
            </td>
          </tr>
        \`).join('');

        const policy = await api('/api/v1/admin/dispatch-policy');
        const pBox = document.getElementById('policyParams');
        pBox.innerHTML = \`
          <div class="card" style="margin-bottom:0;">
            <div class="stat-label">Search Radius</div>
            <div class="stat-value">\${Number(policy.search_radii_m?.[0] || 5000)} m</div>
          </div>
          <div class="card" style="margin-bottom:0;">
            <div class="stat-label">Max Active Parcels</div>
            <div class="stat-value">\${Number(policy.max_active_parcels || 2)}</div>
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
            <td><strong>\${escapeHtml((t.vehicle || 'STANDARD').toUpperCase())}</strong></td>
            <td>\${ghc(t.base_minor)}</td>
            <td>\${ghc(t.per_km_minor)}</td>
            <td>\${ghc(t.per_minute_minor || 0)}</td>
            <td><span class="badge badge-active">\${(t.commission_bps / 100).toFixed(1)}% (\${escapeHtml(t.commission_mode || 'pct')})</span></td>
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
            <td><strong>\${escapeHtml(r.name)}</strong><br><small style="color:var(--text-muted);">\${escapeHtml(r.reason || '')}</small></td>
            <td><span class="badge badge-active">\${escapeHtml(r.category.replaceAll('_', ' ').toUpperCase())}</span></td>
            <td>\${escapeHtml(r.scope_type.toUpperCase())}\${r.scope_id ? '<br><small>' + escapeHtml(r.scope_id.substring(0,8)) + '...</small>' : ''}</td>
            <td><strong>\${escapeHtml(r.ratePercent)}</strong></td>
            <td>\${Number(r.applied_orders || 0)}\${r.max_orders ? ' / ' + Number(r.max_orders) : ''}</td>
            <td><span class="badge \${r.status === 'active' ? 'badge-active' : r.status === 'paused' ? 'badge-warning' : 'badge-danger'}">\${escapeHtml(r.status.toUpperCase())}</span></td>
            <td>
              \${r.status === 'active' ? \`<button class="action-btn" onclick="pauseCommissionRule('\${escapeHtml(r.id)}')">Pause</button>\` : ''}
              \${r.status === 'paused' ? \`<button class="action-btn" onclick="resumeCommissionRule('\${escapeHtml(r.id)}')">Resume</button>\` : ''}
              \${r.status !== 'revoked' ? \`<button class="action-btn" style="color:var(--danger-color);" onclick="revokeCommissionRule('\${escapeHtml(r.id)}')">Revoke</button>\` : ''}
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
            <td>\${escapeHtml(r.phone || r.id.slice(0, 8))}</td>
            <td>COURIER</td>
            <td>\${escapeHtml(r.vehicle || 'motorcycle')}</td>
            <td><span class="badge badge-warn">\${escapeHtml(r.status.toUpperCase())}</span></td>
            <td>
              <button class="action-btn" onclick="reviewRider('\${escapeHtml(r.id)}', 'approved')">Approve</button>
              <button class="action-btn btn-danger" onclick="reviewRider('\${escapeHtml(r.id)}', 'suspended')">Reject</button>
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
        tb.innerHTML = signals.map(s => {
          const isPending = (s.review_status || 'pending') === 'pending' && !s.reviewed;
          const flagCode = s.signal_code || s.signal_type || 'RISK_SIGNAL';
          const sev = (s.severity || 'warn').toUpperCase();
          return \`
          <tr>
            <td><code>#\${escapeHtml(String(s.id))}</code></td>
            <td>\${s.rider_id ? escapeHtml(String(s.rider_id).slice(0,8)) : 'N/A'}</td>
            <td><span class="badge badge-danger">\${escapeHtml(flagCode)}</span></td>
            <td>Severity: <strong>\${escapeHtml(sev)}</strong>\${s.shipment_id ? ' • Shipment ' + escapeHtml(String(s.shipment_id).slice(0,8)) : ''}</td>
            <td>\${escapeHtml((s.review_status || (s.reviewed ? 'reviewed' : 'pending')).toUpperCase())}</td>
            <td>
              \${isPending ? \`
                <button class="action-btn" onclick="reviewRisk(\${Number(s.id)}, 'reviewed')">Mark Reviewed</button>
                <button class="action-btn" onclick="reviewRisk(\${Number(s.id)}, 'dismissed')">Dismiss</button>
              \` : 'Done'}
            </td>
          </tr>
        \`;}).join('');
      } catch (e) {
        console.error(e);
      }
    }

    async function reviewRisk(id, decision = 'reviewed') {
      const reasonInput = prompt('Enter operator review rationale (minimum 12 characters):', 'Operator manual inspection verified signal evidence.');
      if (!reasonInput || reasonInput.trim().length < 12) {
        if (reasonInput !== null) alert('Review reason must be at least 12 characters.');
        return;
      }
      try {
        await api('/api/v1/admin/risk-signals/review', {
          method: 'POST',
          body: JSON.stringify({ signalId: Number(id), decision, reason: reasonInput.trim() })
        });
        loadRisk();
      } catch (e) {
        alert(e.message);
      }
    }

    async function loadFinance() {
      try {
        const walletOverview = await api('/api/v1/admin/finance/wallet-overview').catch(() => null);
        if (walletOverview) {
          document.getElementById('walletTotalDebt').textContent = ghc(walletOverview.summary?.totalDebtMinor || 0);
          document.getElementById('walletRestrictedRiders').textContent = String(walletOverview.summary?.restrictedRidersCount || 0);
          document.getElementById('walletTotalRecovered').textContent = ghc(walletOverview.summary?.totalRecoveredMinor || 0);
          if (walletOverview.policy?.debt_limit_minor) {
            document.getElementById('walletPolicyLimit').textContent = ghc(walletOverview.policy.debt_limit_minor);
          }
        }
      } catch (e) {
        console.error('Wallet overview load failed', e);
      }
      try {
        const aging = await api('/api/v1/admin/finance/aging').catch(() => []);
        const totalOutstanding = Array.isArray(aging)
          ? aging.reduce((s, r) => s + Number(r.outstanding_minor || 0), 0)
          : Number(aging?.currentMinor || 0);
        document.getElementById('agingCurrent').textContent = ghc(totalOutstanding);
        document.getElementById('agingOverdue').textContent = ghc(aging?.overdueMinor || 0);
        document.getElementById('agingCritical').textContent = ghc(aging?.criticalMinor || 0);
      } catch (e) {
        console.error(e);
      }
      try {
        const payouts = await api('/api/v1/admin/payments/payouts').catch(() => []);
        const ptb = document.getElementById('payoutsTable');
        if (!payouts.length) {
          ptb.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 16px;">No payout operations queued.</td></tr>';
        } else {
          ptb.innerHTML = payouts.map(p => {
            const selfProposed = currentAdmin && p.proposed_by === currentAdmin.id;
            const badgeClass = p.status === 'paid' ? 'badge-active' : ['failed', 'needs_review'].includes(p.status) ? 'badge-danger' : 'badge-warn';
            return \`
              <tr>
                <td><code>\${escapeHtml(p.id.slice(0,8))}</code></td>
                <td><code>\${escapeHtml(p.shipment_id.slice(0,8))}</code> • <strong>\${escapeHtml(p.kind.toUpperCase())}</strong></td>
                <td>\${escapeHtml(p.recipient_reference)}<br><small style="color:var(--text-muted);">Beneficiary: \${escapeHtml(p.beneficiary_id.slice(0,8))}\${p.company_id ? ' (Co: ' + escapeHtml(p.company_id.slice(0,8)) + ')' : ''}</small></td>
                <td><strong>\${ghc(p.amount_minor)}</strong></td>
                <td><span class="badge \${badgeClass}">\${escapeHtml(p.status.toUpperCase())}</span>\${p.failure_reason ? '<br><small style="color:var(--danger);">' + escapeHtml(p.failure_reason) + '</small>' : ''}</td>
                <td>
                  \${p.status === 'proposed' ? (selfProposed
                    ? '<span style="font-size:11px;color:var(--text-muted);">Awaiting 2nd Approver</span>'
                    : \`<button class="action-btn" onclick="approvePayoutOp('\${escapeHtml(p.id)}')">Approve (2nd Admin)</button>\`) : ''}
                  \${['approved', 'initiating', 'pending', 'needs_review'].includes(p.status) ? \`<button class="action-btn" onclick="reconcilePayoutOp('\${escapeHtml(p.id)}')">Reconcile</button>\` : ''}
                  \${p.status === 'failed' ? \`<button class="action-btn" onclick="retryPayoutOp('\${escapeHtml(p.id)}')">Safe Retry</button>\` : ''}
                </td>
              </tr>
            \`;
          }).join('');
        }
      } catch (e) {
        console.error(e);
      }
      try {
        const refunds = await api('/api/v1/admin/payments/refunds').catch(() => []);
        const rtb = document.getElementById('refundsTable');
        if (!refunds.length) {
          rtb.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 16px;">No refund operations queued.</td></tr>';
        } else {
          rtb.innerHTML = refunds.map(r => {
            const badgeClass = r.status === 'refunded' ? 'badge-active' : ['failed', 'needs_review'].includes(r.status) ? 'badge-danger' : 'badge-warn';
            return \`
              <tr>
                <td><code>\${escapeHtml(r.id.slice(0,8))}</code></td>
                <td><code>\${escapeHtml(r.shipment_id.slice(0,8))}</code></td>
                <td><code>\${escapeHtml(r.reference || r.provider_reference || r.provider_id || '')}</code></td>
                <td><strong>\${ghc(r.amount_minor)}</strong></td>
                <td><span class="badge \${badgeClass}">\${escapeHtml(r.status.toUpperCase())}</span><br><small style="color:var(--text-muted);">\${escapeHtml(r.failure_reason || r.reason || '')}</small></td>
                <td>
                  \${r.status === 'queued' ? \`<button class="action-btn" onclick="submitRefundOp('\${escapeHtml(r.id)}')">Submit Refund</button>\` : ''}
                  \${['pending', 'initiating', 'needs_review'].includes(r.status) ? \`<button class="action-btn" onclick="reconcileRefundOp('\${escapeHtml(r.id)}')">Reconcile</button>\` : ''}
                  \${r.status === 'failed' ? \`<button class="action-btn" onclick="retryRefundOp('\${escapeHtml(r.id)}')">Safe Retry</button>\` : ''}
                </td>
              </tr>
            \`;
          }).join('');
        }
      } catch (e) {
        console.error(e);
      }
    }

    async function runWalletReconciliation() {
      const notice = document.getElementById('reconciliationNotice');
      if (notice) notice.textContent = 'Running reconciliation...';
      try {
        const res = await api('/api/v1/admin/finance/reconciliation', {
          method: 'POST',
          body: JSON.stringify({ repair: true })
        });
        if (notice) {
          const recCount = res.repairRecoveries?.length || 0;
          notice.textContent = 'Completed: ' + recCount + ' auto-recoveries executed.';
        }
        loadFinance();
      } catch (err) {
        if (notice) notice.textContent = 'Reconciliation failed: ' + err.message;
      }
    }

    async function handleProposePayout(e) {
      e.preventDefault();
      const shipmentId = document.getElementById('proposeShipmentId').value.trim();
      const kind = document.getElementById('proposePayoutKind').value;
      try {
        await api('/api/v1/admin/payments/payouts', {
          method: 'POST',
          body: JSON.stringify({ shipmentId, kind })
        });
        document.getElementById('proposeShipmentId').value = '';
        loadFinance();
      } catch (err) {
        alert(err.message);
      }
    }

    async function approvePayoutOp(id) {
      try { await api(\`/api/v1/admin/payments/payouts/\${id}/approve\`, { method: 'POST', body: '{}' }); loadFinance(); }
      catch (err) { alert(err.message); }
    }
    async function reconcilePayoutOp(id) {
      try { await api(\`/api/v1/admin/payments/payouts/\${id}/reconcile\`, { method: 'POST', body: '{}' }); loadFinance(); }
      catch (err) { alert(err.message); }
    }
    async function retryPayoutOp(id) {
      try { await api(\`/api/v1/admin/payments/payouts/\${id}/retry\`, { method: 'POST', body: '{}' }); loadFinance(); }
      catch (err) { alert(err.message); }
    }
    async function submitRefundOp(id) {
      try { await api(\`/api/v1/admin/payments/refunds/\${id}/submit\`, { method: 'POST', body: '{}' }); loadFinance(); }
      catch (err) { alert(err.message); }
    }
    async function reconcileRefundOp(id) {
      try { await api(\`/api/v1/admin/payments/refunds/\${id}/reconcile\`, { method: 'POST', body: '{}' }); loadFinance(); }
      catch (err) { alert(err.message); }
    }
    async function retryRefundOp(id) {
      try { await api(\`/api/v1/admin/payments/refunds/\${id}/retry\`, { method: 'POST', body: '{}' }); loadFinance(); }
      catch (err) { alert(err.message); }
    }

    async function loadPaymentMethods() {
      try {
        const methods = await api('/api/v1/admin/payments/methods');
        const tb = document.getElementById('paymentsTable');
        tb.innerHTML = methods.map(m => \`
          <tr>
            <td><strong>\${escapeHtml(m.method)}</strong></td>
            <td>\${m.method === 'CASH' ? 'Cash at pickup or drop-off' : m.method === 'MOMO' ? 'Mobile Money (MTN, Telecel, AT)' : m.method === 'CARD' ? 'Debit / Credit Card (Hosted)' : 'Scan & Pay QR'}</td>
            <td><span class="badge \${m.enabled ? 'badge-active' : 'badge-danger'}">\${m.enabled ? 'ACTIVE' : 'DISABLED'}</span></td>
            <td>
              <button class="action-btn" onclick="togglePaymentMethod('\${escapeHtml(m.method)}', \${!m.enabled})">\${m.enabled ? 'Disable' : 'Enable'}</button>
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

    async function loadPromotionsTab() {
      try {
        const settings = await api('/api/v1/admin/commission/restaurant-settings');
        if (settings) {
          document.getElementById('restDefaultCommPct').value = ((settings.default_commission_bps || 1000) / 100).toFixed(1);
          document.getElementById('restDefaultCommBasis').value = settings.default_commission_basis || 'gross_subtotal';
        }
      } catch (e) { console.error(e); }

      try {
        const promos = await api('/api/v1/admin/promotions');
        const tb = document.getElementById('adminPromotionsTable');
        if (!promos || promos.length === 0) {
          tb.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:16px;">No promotion campaigns created yet.</td></tr>';
          return;
        }
        tb.innerHTML = promos.map(p => \`
          <tr>
            <td><strong>\${escapeHtml(p.name)}</strong>\${p.promoCode ? '<br><code>' + escapeHtml(p.promoCode) + '</code>' : ''}</td>
            <td><span class="badge badge-active">\${escapeHtml(p.ownerType.toUpperCase())}</span><br><small>ELESEND \${(p.elesendFundingBps/100).toFixed(0)}% / Rest \${(p.restaurantFundingBps/100).toFixed(0)}%</small></td>
            <td>\${p.discountType === 'percentage_off' ? (p.discountBps/100).toFixed(1) + '% OFF' : p.discountType === 'free_delivery' ? 'FREE DELIVERY' : ghc(p.discountAmountMinor) + ' OFF'}</td>
            <td>\${ghc(p.spentBudgetMinor || 0)}\${p.budgetCapMinor ? ' / ' + ghc(p.budgetCapMinor) : ' (Unlimited)'}</td>
            <td>\${Number(p.redemptionsUsed || 0)}\${p.maxTotalRedemptions ? ' / ' + Number(p.maxTotalRedemptions) : ''}</td>
            <td><span class="badge \${p.status === 'active' ? 'badge-active' : 'badge-warn'}">\${escapeHtml(p.status.toUpperCase())}</span></td>
            <td>
              \${p.ownerType === 'joint' ? \`<button class="action-btn" onclick="inviteRestaurantToPromo('\${escapeHtml(p.id)}')">Invite Merchant</button>\` : ''}
              \${p.status === 'active' ? \`<button class="action-btn" onclick="setAdminPromoStatus('\${escapeHtml(p.id)}', 'paused')">Pause</button>\` : ''}
              \${p.status === 'paused' ? \`<button class="action-btn" onclick="setAdminPromoStatus('\${escapeHtml(p.id)}', 'active')">Resume</button>\` : ''}
            </td>
          </tr>
        \`).join('');
      } catch (e) { console.error(e); }
    }

    async function handleSaveRestaurantCommissionSettings(e) {
      e.preventDefault();
      const pct = parseFloat(document.getElementById('restDefaultCommPct').value || '10');
      const basis = document.getElementById('restDefaultCommBasis').value;
      const rationale = document.getElementById('restCommRationale').value.trim();
      try {
        await api('/api/v1/admin/commission/restaurant-settings', {
          method: 'POST',
          body: JSON.stringify({
            defaultCommissionBps: Math.round(pct * 100),
            defaultCommissionBasis: basis,
            rationale
          })
        });
        alert('Global restaurant commission settings updated.');
        loadPromotionsTab();
      } catch (err) { alert(err.message); }
    }

    async function handleSaveRestaurantAgreement(e) {
      e.preventDefault();
      const restId = document.getElementById('agreeRestId').value.trim();
      const rateVal = document.getElementById('agreeRatePct').value;
      const tier = document.getElementById('agreeTier').value;
      const basis = document.getElementById('agreeBasis').value || null;
      const contractNotes = document.getElementById('agreeNotes').value.trim();
      try {
        await api(\`/api/v1/admin/restaurants/\${restId}/commission-agreement\`, {
          method: 'POST',
          body: JSON.stringify({
            customCommissionBps: rateVal !== '' ? Math.round(parseFloat(rateVal) * 100) : null,
            commissionTier: tier,
            commissionCalculationBasis: basis,
            contractNotes
          })
        });
        alert('Merchant commission agreement saved.');
      } catch (err) { alert(err.message); }
    }

    async function handleCreateAdminPromotion(e) {
      e.preventDefault();
      const name = document.getElementById('promoName').value.trim();
      const ownerType = document.getElementById('promoOwnerType').value;
      const discountType = document.getElementById('promoDiscountType').value;
      const val = parseFloat(document.getElementById('promoValue').value || '0');
      const promoCode = document.getElementById('promoCode').value.trim() || null;
      const budgetGhc = parseFloat(document.getElementById('promoBudgetGhc').value || '0');
      const restSharePct = parseFloat(document.getElementById('promoRestSharePct').value || '0');
      const commConcessionPct = parseFloat(document.getElementById('promoCommConcessionPct').value || '0');

      const restBps = ownerType === 'joint' ? Math.round(restSharePct * 100) : 0;
      const elesendBps = 10000 - restBps;

      try {
        await api('/api/v1/admin/promotions', {
          method: 'POST',
          body: JSON.stringify({
            name,
            ownerType,
            discountType,
            fundingSource: ownerType === 'joint' ? 'joint' : 'elesend',
            discountBps: discountType === 'percentage_off' ? Math.round(val * 100) : null,
            discountAmountMinor: discountType !== 'percentage_off' && discountType !== 'free_delivery' ? Math.round(val * 100) : null,
            promoCode,
            budgetCapMinor: budgetGhc > 0 ? Math.round(budgetGhc * 100) : null,
            elesendFundingBps: elesendBps,
            restaurantFundingBps: restBps,
            commissionConcessionBps: Math.round(commConcessionPct * 100),
            status: 'active'
          })
        });
        alert('Promotion campaign created.');
        loadPromotionsTab();
      } catch (err) { alert(err.message); }
    }

    async function inviteRestaurantToPromo(campaignId) {
      const restId = prompt('Enter Restaurant UUID to invite to this Joint Co-Funded Campaign (requires merchant explicit consent):');
      if (!restId) return;
      try {
        await api(\`/api/v1/admin/promotions/\${campaignId}/invite-restaurants\`, {
          method: 'POST',
          body: JSON.stringify({ restaurantIds: [restId.trim()] })
        });
        alert('Invitation sent to merchant portal for explicit opt-in consent.');
      } catch (err) { alert(err.message); }
    }

    async function setAdminPromoStatus(campaignId, status) {
      const reason = prompt('Enter reason for status change:', 'Operator campaign adjustment');
      if (!reason) return;
      try {
        await api(\`/api/v1/admin/promotions/\${campaignId}/status\`, {
          method: 'POST',
          body: JSON.stringify({ status, reason })
        });
        loadPromotionsTab();
      } catch (err) { alert(err.message); }
    }

    async function loadSupportChatTab() {
      try {
        const data = await api('/api/v1/admin/chat/support-queue');
        const convTb = document.getElementById('supportConversationsTable');
        const convs = data.supportConversations || [];
        if (!convs.length) {
          convTb.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:16px;">No active support escalations in queue.</td></tr>';
        } else {
          convTb.innerHTML = convs.map(c => \`
            <tr>
              <td><code>\${escapeHtml(c.id.slice(0,8))}</code></td>
              <td><strong>\${escapeHtml((c.supportCategory || 'general').toUpperCase())}</strong><br><small>\${c.foodOrderId ? 'Food Order ' + escapeHtml(c.foodOrderId.slice(0,8)) : c.shipmentId ? 'Shipment ' + escapeHtml(c.shipmentId.slice(0,8)) : ''}</small></td>
              <td><span class="badge badge-active">\${escapeHtml(c.state)}</span></td>
              <td>\${escapeHtml(c.lastMessagePreview || 'No messages yet')}</td>
              <td><button class="action-btn" onclick="inspectSupportConversation('\${escapeHtml(c.id)}')">Open Thread</button></td>
            </tr>
          \`).join('');
        }

        const repTb = document.getElementById('abuseReportsTable');
        const reports = data.abuseReports || [];
        if (!reports.length) {
          repTb.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:16px;">No chat abuse reports filed.</td></tr>';
        } else {
          repTb.innerHTML = reports.map(r => \`
            <tr>
              <td><code>\${escapeHtml(r.id.slice(0,8))}</code><br><small>Role: \${escapeHtml(r.reporter_role)}</small></td>
              <td><span class="badge badge-danger">\${escapeHtml(r.category.toUpperCase())}</span></td>
              <td><strong>\${escapeHtml(r.message_body || '(Conversation Report)')}</strong><br><small style="color:var(--text-muted);">\${escapeHtml(r.details)}</small></td>
              <td><span class="badge \${r.status === 'resolved' ? 'badge-active' : 'badge-warn'}">\${escapeHtml(r.status.toUpperCase())}</span></td>
              <td>
                \${r.status === 'open' || r.status === 'investigating' ? \`
                  <button class="action-btn" onclick="moderateAbuseReport('\${escapeHtml(r.id)}', true)">Redact & Resolve</button>
                  <button class="action-btn" onclick="moderateAbuseReport('\${escapeHtml(r.id)}', false)">Dismiss</button>
                \` : 'Handled'}
              </td>
            </tr>
          \`).join('');
        }
      } catch (e) { console.error(e); }
    }

    async function inspectSupportConversation(convId) {
      try {
        const res = await api(\`/api/v1/chat/conversations/\${convId}/messages?justification=Support%20Queue%20Investigation\`);
        document.getElementById('supportActiveConvId').value = convId;
        document.getElementById('supportInspectorTitle').textContent = 'Support Thread #' + convId.slice(0, 8);
        const box = document.getElementById('supportInspectorMessages');
        box.innerHTML = (res.messages || []).map(m => \`
          <div style="margin-bottom:8px; padding:8px; border-radius:6px; background:rgba(255,255,255,0.04);">
            <div style="font-size:11px; color:var(--primary); font-weight:700;">\${escapeHtml(m.senderRole.toUpperCase())} • \${escapeHtml(m.deliveryStatus)}</div>
            <div style="font-size:13px; margin-top:2px;">\${escapeHtml(m.body)}</div>
          </div>
        \`).join('') || '<div style="color:var(--text-muted);">No messages yet.</div>';
        document.getElementById('supportInspectorCard').style.display = 'block';
      } catch (err) { alert(err.message); }
    }

    async function handleSendSupportMessage(e) {
      e.preventDefault();
      const convId = document.getElementById('supportActiveConvId').value;
      const body = document.getElementById('supportReplyInput').value.trim();
      if (!convId || !body) return;
      try {
        await api(\`/api/v1/chat/conversations/\${convId}/messages\`, {
          method: 'POST',
          body: JSON.stringify({
            clientMessageId: 'supp-' + Date.now(),
            messageType: 'text',
            body
          })
        });
        document.getElementById('supportReplyInput').value = '';
        await inspectSupportConversation(convId);
        loadSupportChatTab();
      } catch (err) { alert(err.message); }
    }

    async function moderateAbuseReport(reportId, redact) {
      const notes = prompt('Enter mandatory moderation resolution notes (minimum 8 characters):', redact ? 'Verified policy violation; message redacted.' : 'Reviewed and dismissed.');
      if (!notes || notes.trim().length < 8) return;
      try {
        await api(\`/api/v1/admin/chat/abuse-reports/\${reportId}/moderate\`, {
          method: 'POST',
          body: JSON.stringify({
            status: redact ? 'resolved' : 'dismissed',
            redactMessage: Boolean(redact),
            restrictConversation: false,
            resolutionNotes: notes.trim()
          })
        });
        loadSupportChatTab();
      } catch (err) { alert(err.message); }
    }

    // Initialize
    checkAuth();
  </script>
</body>
</html>`;
}
