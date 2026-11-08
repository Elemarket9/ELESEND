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
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, sans-serif; }
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
        <button class="tab-btn" onclick="switchTab('mapReviewTab', this)">🗺️ Map Review</button>
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
          <div class="card-subtitle">Delivery commission default is 13%. Staff can set 0 to 100%, to 0.01%.</div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>Base Fare</th>
                  <th>Per-Km Fare</th>
                  <th>Per-Min</th>
                  <th>Commission</th>
                  <th>Minimum</th>
                  <th>Rush Hour</th>
                  <th>Booking Fee</th>
                  <th>Waiting/Min</th>
                </tr>
              </thead>
              <tbody id="pricingTable">
                <tr><td colspan="9" style="text-align: center; color: var(--text-muted);">Loading pricing...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Change a Vehicle Tariff</div>
          <div class="card-subtitle">Saving creates a new tariff version. Issued quotes keep their price.</div>
          <form onsubmit="handleTariffUpdate(event)" style="display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end;">
            <div style="flex: 1; min-width: 120px;"><label class="form-label">Vehicle</label><select id="tariffVehicle" class="form-input" onchange="fillTariffForm()"><option value="motorcycle">Motorcycle</option><option value="car">Car</option><option value="van">Van</option></select></div>
            <div style="flex: 1; min-width: 120px;"><label class="form-label">Start GH₵</label><input type="number" id="tariffBase" class="form-input" step="0.01" min="0.01" required></div>
            <div style="flex: 1; min-width: 120px;"><label class="form-label">Per km GH₵</label><input type="number" id="tariffKm" class="form-input" step="0.01" min="0" required></div>
            <div style="flex: 1; min-width: 120px;"><label class="form-label">Per minute GH₵</label><input type="number" id="tariffMin" class="form-input" step="0.01" min="0" required></div>
            <div style="flex: 1; min-width: 120px;"><label class="form-label">Minimum GH₵</label><input type="number" id="tariffMinimum" class="form-input" step="0.01" min="0" required></div>
            <div style="flex: 1; min-width: 120px;"><label class="form-label">Rush multiplier</label><input type="number" id="tariffRush" class="form-input" step="0.01" min="1" max="2" required></div>
            <div style="flex: 1; min-width: 120px;"><label class="form-label">Rush hour</label><select id="tariffRushOn" class="form-input"><option value="true">On</option><option value="false">Off</option></select></div>
            <div style="flex: 1; min-width: 120px;"><label class="form-label">Booking fee %</label><input type="number" id="tariffBooking" class="form-input" step="0.01" min="0" max="30" required></div>
            <div style="flex: 1; min-width: 120px;"><label class="form-label">Waiting GH₵/min</label><input type="number" id="tariffWait" class="form-input" step="0.01" min="0" max="10" required></div>
            <button type="submit" class="action-btn">Save tariff</button>
          </form>
        </div>

        <div class="card">
          <div class="card-title">Tolls</div>
          <div class="card-subtitle">Add a toll only where riders really pay one. It goes to the rider in full, with no commission.</div>
          <form onsubmit="handleTollAdd(event)" style="display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end;">
            <div style="flex: 2; min-width: 140px;"><label class="form-label">Name</label><input id="tollName" class="form-input" required></div>
            <div style="flex: 1; min-width: 110px;"><label class="form-label">Latitude</label><input type="number" id="tollLat" class="form-input" step="any" required></div>
            <div style="flex: 1; min-width: 110px;"><label class="form-label">Longitude</label><input type="number" id="tollLng" class="form-input" step="any" required></div>
            <div style="flex: 1; min-width: 110px;"><label class="form-label">Radius m</label><input type="number" id="tollRadius" class="form-input" value="50" min="10" max="100" required></div>
            <div style="flex: 1; min-width: 110px;"><label class="form-label">Amount GH₵</label><input type="number" id="tollAmount" class="form-input" step="0.01" min="0.01" required></div>
            <div style="flex: 2; min-width: 140px;"><label class="form-label">Source</label><input id="tollSource" class="form-input" required></div>
            <button type="submit" class="action-btn">Add toll</button>
          </form>
          <div class="table-container"><table><thead><tr><th>Name</th><th>Amount</th><th>Source</th><th></th></tr></thead><tbody id="tollTable"></tbody></table></div>
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
          <div class="card-title"><span>Restaurants Waiting For Approval</span></div>
          <div class="card-subtitle">Customers can order from a restaurant once it is approved.</div>
          <div class="table-container">
            <table>
              <thead><tr><th>Restaurant</th><th>Phone</th><th>Address</th><th>Action</th></tr></thead>
              <tbody id="restaurantApprovalTable"></tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-title"><span>Orders Needing Attention</span></div>
          <div class="card-subtitle">Orders with no rider, handover codes that could not be sent, and riders who became unresponsive.</div>
          <div class="table-container">
            <table>
              <thead><tr><th>Time</th><th>Problem</th><th>Order state</th><th>Customer</th><th>Rider</th></tr></thead>
              <tbody id="attentionTable"></tbody>
            </table>
          </div>
        </div>
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
            <span>Missing Parcels</span>
            <button class="action-btn" onclick="loadCustody()">Refresh</button>
          </div>
          <div class="card-subtitle">Parcels still with a rider after the time limit. The rider is suspended automatically. Check the facts and try to reach the rider before reporting to the police.</div>
          <div id="custodyList"></div>
        </div>
        <div class="card">
          <div class="card-title"><span>Stuck Withdrawals</span><button class="action-btn" onclick="loadStuckWithdrawals()">Refresh</button></div>
          <div class="card-subtitle">The system keeps retrying safely. Release only after confirming in the Paystack dashboard that no transfer exists.</div>
          <div id="stuckList"></div>
        </div>
        <div class="card">
          <div class="card-title"><span>Emergency Alerts</span><button class="action-btn" onclick="loadSafety()">Refresh</button></div>
          <div id="safetyList"></div>
        </div>
        <div class="card">
          <div class="card-title"><span>Rider Reward Campaign</span></div>
          <div class="card-subtitle">Rewards are commission credit, used against future cash commission.</div>
          <input id="rewardTitle" placeholder="Title"> <input id="rewardTarget" type="number" placeholder="Deliveries"> <input id="rewardAmount" type="number" placeholder="Reward (GH₵)"> <input id="rewardDays" type="number" placeholder="Days">
          <button class="action-btn" onclick="createReward()">Create</button>
        </div>
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
          <div class="card-subtitle">Exceptions only. Riders are paid through their own withdrawals, so use this just to correct a problem payout. Requires a second finance admin to approve.</div>
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

      <!-- PANEL 9: Rider-found roads and places -->
      <div id="mapReviewTab" class="panel">
        <div class="card">
          <div class="card-title"><span>Roads found by riders</span><button class="action-btn" onclick="loadMapReview()">Refresh</button></div>
          <p id="mapReviewRules" style="color:var(--text-muted); font-size:13px;"></p>
          <div id="mapReviewRoads"></div>
        </div>
        <div class="card">
          <div class="card-title"><span>Places reported by riders</span></div>
          <div id="mapReviewLandmarks"></div>
        </div>
        <div class="card">
          <div class="card-title"><span>Recently published</span></div>
          <div id="mapReviewPublished"></div>
        </div>
        <div class="card">
          <div class="card-title"><span>Satellite change scans</span></div>
          <div id="mapReviewScans"></div>
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
    // Staff sign-ins last only for this tab, so closing the browser on a shared computer signs out. A copy kept by
    // older versions of this page is removed.
    try { localStorage.removeItem('elesend_admin_token'); } catch (e) {}
    let token = (() => { try { return sessionStorage.getItem('elesend_admin_token') || ''; } catch (e) { return ''; } })();
    
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
        try { sessionStorage.removeItem('elesend_admin_token'); } catch (e) {}
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
        try { sessionStorage.setItem('elesend_admin_token', token); } catch (e) {}
        await checkAuth();
      } catch (err) {
        errBox.textContent = '⚠️ ' + err.message;
        errBox.style.display = 'block';
      }
    }

    async function logout() {
      try { await api('/api/v1/auth/logout', { method: 'POST' }); } catch {}
      token = '';
      try { sessionStorage.removeItem('elesend_admin_token'); } catch (e) {}
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
      if (tabId === 'mapReviewTab') loadMapReview();
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
        window.__tariffs = tariffs;
        fillTariffForm();
        loadTolls();
        tb.innerHTML = tariffs.map(t => \`
          <tr>
            <td><strong>\${escapeHtml((t.vehicle || 'STANDARD').toUpperCase())}</strong></td>
            <td>\${ghc(t.base_minor)}</td>
            <td>\${ghc(t.per_km_minor)}</td>
            <td>\${ghc(t.per_minute_minor || 0)}</td>
            <td><span class="badge badge-active">\${(t.commission_bps / 100).toFixed(2)}% (\${escapeHtml(t.commission_mode || 'pct')})</span></td>
            <td>\${ghc(t.minimum_minor || 0)}</td>
            <td>\${t.traffic_time_pricing ? 'By trip time' : t.rush_hour_enabled ? (Number(t.rush_hour_bps || 14000) / 10000).toFixed(2) + 'x' : 'Off'}</td>
            <td>\${(Number(t.booking_fee_bps || 0) / 100).toFixed(2)}%</td>
            <td>\${ghc(t.wait_per_minute_minor || 0)}</td>
          </tr>
        \`).join('');
      } catch (e) {
        console.error(e);
      }
    }

    function fillTariffForm() {
      const vehicle = document.getElementById('tariffVehicle').value;
      const t = (window.__tariffs || []).find(x => x.vehicle === vehicle);
      if (!t) return;
      const set = (id, value) => { document.getElementById(id).value = value; };
      set('tariffBase', (t.base_minor / 100).toFixed(2));
      set('tariffKm', (t.per_km_minor / 100).toFixed(2));
      set('tariffMin', ((t.per_minute_minor || 0) / 100).toFixed(2));
      set('tariffMinimum', ((t.minimum_minor || 0) / 100).toFixed(2));
      set('tariffRush', (Number(t.rush_hour_bps || 14000) / 10000).toFixed(2));
      set('tariffRushOn', String(Boolean(t.rush_hour_enabled)));
      set('tariffBooking', (Number(t.booking_fee_bps || 0) / 100).toFixed(2));
      set('tariffWait', ((t.wait_per_minute_minor || 0) / 100).toFixed(2));
    }

    async function handleTariffUpdate(e) {
      e.preventDefault();
      const vehicle = document.getElementById('tariffVehicle').value;
      const t = (window.__tariffs || []).find(x => x.vehicle === vehicle);
      if (!t) { alert('Load the tariffs first.'); return; }
      const num = id => parseFloat(document.getElementById(id).value);
      if (!confirm('Save a new ' + vehicle + ' tariff? New quotes use it straight away.')) return;
      try {
        await api('/api/v1/admin/pricing/vehicles', {
          method: 'POST',
          body: JSON.stringify({
            vehicle,
            baseMinor: Math.round(num('tariffBase') * 100),
            perKmMinor: Math.round(num('tariffKm') * 100),
            perMinuteMinor: Math.round(num('tariffMin') * 100),
            minimumMinor: Math.round(num('tariffMinimum') * 100),
            rushHourEnabled: document.getElementById('tariffRushOn').value === 'true',
            supplyDemandEnabled: Boolean(t.supply_demand_enabled),
            commissionBps: Number(t.commission_bps),
            rushHourBps: Math.round(num('tariffRush') * 10000),
            bookingFeeBps: Math.round(num('tariffBooking') * 100),
            waitPerMinuteMinor: Math.round(num('tariffWait') * 100),
            trafficTimePricing: Boolean(t.traffic_time_pricing)
          })
        });
        alert('Tariff saved.');
        loadPricing();
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    async function loadTolls() {
      try {
        const rules = await api('/api/v1/admin/pricing/tolls');
        const rows = rules.filter(r => !r.effective_to || new Date(r.effective_to) > new Date());
        document.getElementById('tollTable').innerHTML = rows.length ? rows.map(r => \`
          <tr>
            <td>\${escapeHtml(r.name)}</td>
            <td>\${ghc(r.amount_minor)}</td>
            <td>\${escapeHtml(r.source || '')}</td>
            <td><button class="action-btn" data-toll="\${escapeHtml(r.id)}" onclick="retireToll(this.dataset.toll)">Retire</button></td>
          </tr>\`).join('') : '<tr><td colspan="4">No tolls. None are charged.</td></tr>';
      } catch (e) {
        console.error(e);
      }
    }

    async function handleTollAdd(e) {
      e.preventDefault();
      const value = id => document.getElementById(id).value;
      try {
        await api('/api/v1/admin/pricing/tolls', {
          method: 'POST',
          body: JSON.stringify({
            name: value('tollName'),
            latitude: parseFloat(value('tollLat')),
            longitude: parseFloat(value('tollLng')),
            radiusMeters: parseInt(value('tollRadius'), 10),
            vehicles: ['motorcycle', 'car', 'van'],
            amountMinor: Math.round(parseFloat(value('tollAmount')) * 100),
            source: value('tollSource')
          })
        });
        e.target.reset();
        loadTolls();
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    }

    async function retireToll(id) {
      if (!confirm('Retire this toll? New quotes stop charging it.')) return;
      try {
        await api('/api/v1/admin/pricing/tolls/' + id + '/retire', { method: 'POST', body: '{}' });
        loadTolls();
      } catch (err) {
        alert('Failed: ' + err.message);
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

    async function loadAttention() {
      const rows = await api('/api/v1/admin/dispatch/exceptions').catch(() => null);
      const tb = document.getElementById('attentionTable');
      if (!rows) { tb.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">You do not have permission to view this list.</td></tr>'; return; }
      tb.innerHTML = rows.length ? rows.map(r => \`
        <tr>
          <td>\${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
          <td>\${escapeHtml(r.reason)}</td>
          <td>\${escapeHtml(r.state)}\${r.paid ? ' (paid)' : ''}</td>
          <td>\${escapeHtml(r.customer_phone)}</td>
          <td>\${escapeHtml(r.rider_phone || '-')}</td>
        </tr>\`).join('') : '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Nothing needs attention.</td></tr>';
    }

    async function loadRestaurantApprovals() {
      const rows = await api('/api/v1/admin/restaurants').catch(() => null);
      const tb = document.getElementById('restaurantApprovalTable');
      const waiting = (rows || []).filter(r => r.status === 'pending');
      tb.innerHTML = waiting.length ? waiting.map(r => \`
        <tr>
          <td>\${escapeHtml(r.name)}</td>
          <td>\${escapeHtml(r.phone)}</td>
          <td>\${escapeHtml(r.address)}</td>
          <td>
            <button class="action-btn" onclick="reviewRestaurant('\${escapeHtml(r.id)}', 'approved')">Approve</button>
            <button class="action-btn btn-danger" onclick="reviewRestaurant('\${escapeHtml(r.id)}', 'rejected')">Reject</button>
          </td>
        </tr>\`).join('') : '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No restaurants waiting.</td></tr>';
    }

    async function reviewRestaurant(id, status) {
      try {
        await api(\`/api/v1/restaurants/\${id}\`, { method: 'POST', body: JSON.stringify({ status }) });
        loadRestaurantApprovals();
      } catch (e) {
        alert(e.message);
      }
    }

    async function loadFleet() {
      loadAttention();
      loadRestaurantApprovals();
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
            <td>\${escapeHtml(r.vehicle || 'motorcycle')}\${r.licence ? '<br><strong>' + escapeHtml(r.licence.legal_name) + '</strong><br>' + escapeHtml(r.licence.document_type) + ' ' + escapeHtml(r.licence.number) + (r.licence.licence_class ? ' • Class ' + escapeHtml(r.licence.licence_class) : '') + '<br>Expires ' + escapeHtml(r.licence.expires_on) + (r.licence.vehicle_plate ? ' • Plate ' + escapeHtml(r.licence.vehicle_plate) : '') + ' • ' + escapeHtml(r.licence.status) + '<br>Photo check: ' + escapeHtml(r.licence.identity_status) + (r.licence.identity_reason ? ' (' + escapeHtml(r.licence.identity_reason) + ')' : '') : '<br><em>No licence submitted</em>'}</td>
            <td><span class="badge badge-warn">\${escapeHtml(r.status.toUpperCase())}</span></td>
            <td>
              <button class="action-btn" onclick="reviewRider('\${escapeHtml(r.id)}', 'approved')">Approve</button>
              \${r.licence ? \`<button class="action-btn" onclick="rejectLicence('\${escapeHtml(r.id)}')">Reject Licence</button>\` : ''}
              \${(r.documents || []).map(d => \`<button class="action-btn" onclick="viewDocument('\${escapeHtml(r.id)}', '\${escapeHtml(d.kind)}')">\${escapeHtml(d.kind.replace('_', ' '))} (\${escapeHtml(d.status)})</button>\`).join(' ')}
              <button class="action-btn btn-danger" onclick="reviewRider('\${escapeHtml(r.id)}', 'suspended')">Reject</button>
            </td>
          </tr>
        \`).join('') + (queue.companies || []).map(c => \`
          <tr>
            <td>\${escapeHtml(c.phone || c.id.slice(0, 8))}</td>
            <td>COMPANY</td>
            <td><strong>\${escapeHtml(c.name)}</strong><br>\${escapeHtml((c.services || []).join(' and '))}</td>
            <td><span class="badge badge-warn">\${escapeHtml(c.status.toUpperCase())}</span></td>
            <td>
              \${c.status === 'approved' ? '' : \`<button class="action-btn" onclick="reviewCompany('\${escapeHtml(c.id)}', 'approved')">Approve</button>\`}
              <button class="action-btn btn-danger" onclick="reviewCompany('\${escapeHtml(c.id)}', '\${c.status === 'approved' ? 'suspended' : 'rejected'}')">\${c.status === 'approved' ? 'Suspend' : 'Reject'}</button>
            </td>
          </tr>
        \`).join('');
      } catch (e) {
        console.error(e);
      }
    }

    async function reviewCompany(id, status) {
      try {
        await api(\`/api/v1/admin/companies/\${id}\`, { method: 'POST', body: JSON.stringify({ status }) });
        loadFleet();
      } catch (e) {
        alert(e.message);
      }
    }

    async function viewDocument(id, kind) {
      const doc = await api('/api/v1/admin/riders/' + id + '/documents/' + kind);
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;overflow:auto;padding:20px;color:#fff';
      const close = document.createElement('button');
      close.className = 'action-btn';
      close.textContent = 'Close';
      close.onclick = () => box.remove();
      const reject = document.createElement('button');
      reject.className = 'action-btn btn-danger';
      reject.textContent = 'Reject Document';
      reject.onclick = async () => {
        const reason = prompt('Why is this document being rejected?');
        if (!reason) return;
        await api('/api/v1/admin/riders/' + id + '/documents/' + kind + '/reject', { method: 'POST', body: JSON.stringify({ reason }) });
        box.remove();
        loadFleet();
      };
      const info = document.createElement('p');
      info.textContent = kind.replace('_', ' ') + (doc.expiresOn ? ' • Expires ' + doc.expiresOn : '');
      const img = document.createElement('img');
      img.src = 'data:image/jpeg;base64,' + doc.imageBase64;
      img.style.cssText = 'max-width:100%;display:block;margin-top:12px';
      box.append(close, ' ', reject, info, img);
      document.body.appendChild(box);
    }
    async function rejectLicence(id) {
      const reason = prompt('Why is this licence being rejected?');
      if (!reason) return;
      await api('/api/v1/admin/riders/' + id + '/licence/reject', { method: 'POST', body: JSON.stringify({ reason }) });
      loadFleet();
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

    async function loadSafety() {
      const box = document.getElementById('safetyList');
      try {
        const rows = await api('/api/v1/admin/safety-alerts');
        box.textContent = '';
        if (!rows?.length) { box.textContent = 'No emergency alerts.'; return; }
        rows.forEach(a => {
          const line = document.createElement('p');
          line.textContent = [a.status.toUpperCase(), a.kind, a.phone, new Date(a.created_at).toLocaleString(), a.latitude != null ? a.latitude + ',' + a.longitude : 'no location', a.notified_count + ' notified', a.resolution_note || ''].join(' • ') + ' ';
          if (a.status === 'open') {
            const b = document.createElement('button');
            b.className = 'action-btn';
            b.textContent = 'Resolve';
            b.onclick = async () => { const note = prompt('What happened?'); if (!note) return; await api('/api/v1/admin/safety-alerts/' + a.id + '/resolve', { method: 'POST', body: JSON.stringify({ note }) }); loadSafety(); };
            line.appendChild(b);
          }
          box.appendChild(line);
        });
      } catch (e) { box.textContent = e.message; }
    }
    async function createReward() {
      const value = id => document.getElementById(id).value;
      try {
        await api('/api/v1/admin/reward-campaigns', { method: 'POST', body: JSON.stringify({ title: value('rewardTitle'), targetDeliveries: Number(value('rewardTarget')), rewardMinor: Math.round(Number(value('rewardAmount')) * 100), days: Number(value('rewardDays')) }) });
        alert('Campaign created');
      } catch (e) { alert(e.message); }
    }
    async function loadStuckWithdrawals() {
      const box = document.getElementById('stuckList');
      try {
        const rows = (await api('/api/v1/admin/payments/withdrawals')).filter(w => w.hold_reason || (w.stuck_flagged_at && ['initiating', 'pending', 'needs_review'].includes(w.status)));
        box.textContent = rows.length ? '' : 'No stuck withdrawals.';
        rows.forEach(w => {
          const line = document.createElement('p');
          line.textContent = String(w.id).slice(0, 8) + ' • GH₵' + (Number(w.amount_minor) / 100).toFixed(2) + ' • ' + (w.hold_reason ? 'ON HOLD: ' + w.hold_reason : (w.failure_reason || w.status)) + ' ';
          if (w.hold_reason) { box.appendChild(line); return; }
          const b = document.createElement('button');
          b.className = 'action-btn btn-danger';
          b.textContent = 'Release to Balance';
          b.onclick = async () => {
            const reason = prompt('Confirm you checked Paystack and no transfer exists. Reason:');
            if (!reason) return;
            try { await api('/api/v1/admin/payments/withdrawals/' + w.id + '/release-unsent', { method: 'POST', body: JSON.stringify({ reason }) }); } catch (e) { alert(e.message); }
            loadStuckWithdrawals();
          };
          line.appendChild(b);
          box.appendChild(line);
        });
      } catch (e) { box.textContent = e.message; }
    }
    async function loadCustody() {
      const box = document.getElementById('custodyList');
      try {
        const rows = await api('/api/v1/admin/custody-incidents');
        box.innerHTML = !rows?.length ? '<p>No missing parcels.</p>' : rows.map(i => '<details style="margin-bottom:10px"><summary>'
          + escapeHtml(String(i.shipment_id).slice(0, 8)) + ' • Rider ' + escapeHtml(String(i.evidence?.rider_phone || '')) + ' • ' + escapeHtml(i.outcome || 'OPEN')
          + (i.police_reference ? ' • Police ref ' + escapeHtml(i.police_reference) : '')
          + '</summary><pre style="white-space:pre-wrap">' + escapeHtml(JSON.stringify(i.evidence, null, 2)) + '</pre>'
          + ['police_reported', 'recovered', 'false_alarm'].map(o => '<button class="action-btn" onclick="resolveCustody(\\'' + escapeHtml(i.id) + '\\',\\'' + o + '\\')">' + o.replace('_', ' ') + '</button> ').join('')
          + '</details>').join('');
      } catch (e) { box.textContent = e.message; }
    }
    async function resolveCustody(id, outcome) {
      const reason = prompt('Reason for this decision');
      if (!reason) return;
      const policeReference = outcome === 'police_reported' ? (prompt('Police report reference') || undefined) : undefined;
      await api('/api/v1/admin/custody-incidents/' + id + '/resolve', { method: 'POST', body: JSON.stringify({ outcome, reason, policeReference }) });
      loadCustody();
    }
    async function loadRisk() {
      loadCustody();
      loadStuckWithdrawals();
      loadSafety();
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
        const blockedOutstanding = Array.isArray(aging)
          ? aging.filter(r => r.blocked).reduce((s, r) => s + Number(r.outstanding_minor || 0), 0)
          : Number(aging?.criticalMinor || 0);
        document.getElementById('agingCurrent').textContent = ghc(totalOutstanding);
        document.getElementById('agingOverdue').textContent = ghc(aging?.overdueMinor ?? totalOutstanding);
        document.getElementById('agingCritical').textContent = ghc(aging?.criticalMinor ?? blockedOutstanding);
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
          document.getElementById('restDefaultCommPct').value = ((settings.default_commission_bps || 1000) / 100).toFixed(2);
          document.getElementById('restDefaultCommBasis').value = settings.default_commission_basis || 'gross_subtotal';
        }
      } catch (e) { console.error(e); }

      try {
        const promos = (await api('/api/v1/admin/promotions')).campaigns;
        const tb = document.getElementById('adminPromotionsTable');
        if (!promos || promos.length === 0) {
          tb.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:16px;">No promotion campaigns created yet.</td></tr>';
          return;
        }
        tb.innerHTML = promos.map(p => \`
          <tr>
            <td><strong>\${escapeHtml(p.name)}</strong>\${p.code ? '<br><code>' + escapeHtml(p.code) + '</code>' : ''}</td>
            <td><span class="badge badge-active">\${escapeHtml(p.owner_type.toUpperCase())}</span><br><small>ELESEND \${(Number(p.elesend_funding_bps)/100).toFixed(0)}% / Rest \${(Number(p.restaurant_funding_bps)/100).toFixed(0)}%</small></td>
            <td>\${p.discount_type === 'percentage' ? (Number(p.discount_bps)/100).toFixed(2) + '% OFF' : p.discount_type === 'free_delivery' ? 'FREE DELIVERY' : ghc(p.discount_minor) + ' OFF'}</td>
            <td>\${ghc(p.spent_budget_minor || 0)}\${p.total_budget_minor ? ' / ' + ghc(p.total_budget_minor) : ' (Unlimited)'}</td>
            <td>\${Number(p.redeemed_count || 0)}\${p.total_redemption_limit ? ' / ' + Number(p.total_redemption_limit) : ''}</td>
            <td><span class="badge \${p.status === 'active' ? 'badge-active' : 'badge-warn'}">\${escapeHtml(p.status.toUpperCase())}</span></td>
            <td>
              \${p.owner_type === 'joint' ? \`<button class="action-btn" onclick="inviteRestaurantToPromo('\${escapeHtml(p.id)}')">Invite Merchant</button>\` : ''}
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
            fundingType: ownerType === 'joint' ? 'shared_percentage' : 'elesend_100',
            ...promoDiscountFields(discountType, val),
            code: promoCode,
            totalBudgetMinor: budgetGhc > 0 ? Math.round(budgetGhc * 100) : null,
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

    // Translates the form's discount choice into the API's discount and target fields.
    function promoDiscountFields(choice, value) {
      const amount = Math.round(value * 100);
      if (choice === 'percentage_off') return { discountType: 'percentage', targetType: 'food_subtotal', discountBps: amount };
      if (choice === 'fixed_amount_off') return { discountType: 'fixed', targetType: 'food_subtotal', discountMinor: amount };
      if (choice === 'discounted_delivery') return { discountType: 'fixed', targetType: 'delivery_fee', discountMinor: amount };
      return { discountType: 'free_delivery', targetType: 'delivery_fee' };
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
          body: JSON.stringify({ status, rationale: reason })
        });
        loadPromotionsTab();
      } catch (err) { alert(err.message); }
    }

    function roadSketch(geojson) {
      const points = JSON.parse(geojson).coordinates;
      const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY, 0.00001);
      const line = points.map(p => ((p[0] - minX) / span * 100 + 4).toFixed(1) + ',' + (104 - (p[1] - minY) / span * 100).toFixed(1)).join(' ');
      return '<svg viewBox="0 0 108 108" width="96" height="96" role="img" aria-label="Shape of this road" style="background:rgba(255,255,255,0.05); border-radius:6px; flex:none;"><polyline points="' + line + '" fill="none" stroke="#18C6A5" stroke-width="3"/></svg>';
    }

    async function loadMapReview() {
      try {
        const data = await api('/api/v1/admin/geo-intelligence/review-queue');
        const rules = data.autoPublish;
        document.getElementById('mapReviewRules').textContent = rules.enabled
          ? 'Roads publish themselves after ' + rules.minRiders + ' different riders (' + rules.minRidersWithImagery + ' where satellite images show change), seen at least ' + rules.minSpanHours + ' hours apart, with accurate GPS and joined to the road network. Publish, reject or undo here at any time.'
          : 'EGIA learning and automatic publishing are off. Anything already here waits for your decision.';
        document.getElementById('mapReviewRoads').innerHTML = data.candidateRoads.map(r => {
          const mid = JSON.parse(r.corridor_geojson).coordinates[Math.floor(JSON.parse(r.corridor_geojson).coordinates.length / 2)];
          const id = escapeHtml(r.id);
          return \`<div style="display:flex; flex-wrap:wrap; gap:12px; padding:12px 0; border-bottom:1px solid rgba(255,255,255,0.08);">
            \${roadSketch(r.corridor_geojson)}
            <div style="flex:1; min-width:220px;">
              <strong>\${escapeHtml(r.name || 'Unnamed road')}</strong> <span class="badge \${r.status === 'CORROBORATED' ? 'badge-active' : 'badge-warn'}">\${r.status === 'CORROBORATED' ? 'Confirmed by riders' : 'Seen by one rider'}</span>
              <div style="font-size:13px; color:var(--text-muted); margin-top:4px;">\${Math.round(r.length_m)} m. \${r.distinct_riders} rider(s), \${r.observation_count} sighting(s) over \${Math.round((r.temporal_span_seconds || 0) / 3600)} hours. GPS accuracy about \${Math.round(r.mean_accuracy_m || 0)} m. Vehicles: \${escapeHtml((r.allowed_vehicles || []).join(', '))}.\${r.imagery_supported ? ' Satellite images show change here.' : ''}</div>
              <div style="margin-top:8px; display:flex; flex-wrap:wrap; gap:6px;">
                <a class="action-btn" target="_blank" rel="noopener noreferrer" href="https://www.openstreetmap.org/?mlat=\${Number(mid[1])}&mlon=\${Number(mid[0])}#map=17/\${Number(mid[1])}/\${Number(mid[0])}">View on map</a>
                <button class="action-btn" onclick="mapReviewAct('publish-road', {roadId:'\${id}', notes:'Approved in map review'})">Publish</button>
                <button class="action-btn" onclick="mapReviewAct('reject', {type:'road', id:'\${id}', notes:'Rejected in map review'})">Reject</button>
                <button class="action-btn" onclick="mapReviewAct('road-details', {roadId:'\${id}', isPrivateAccess:\${!r.is_private_access}})">\${r.is_private_access ? 'Not private' : 'Mark private'}</button>
                <button class="action-btn" onclick="mapReviewAct('road-details', {roadId:'\${id}', isPedestrianOnly:\${!r.is_pedestrian_only}})">\${r.is_pedestrian_only ? 'Allow vehicles' : 'Foot traffic only'}</button>
                <button class="action-btn" onclick="mapReviewAct('road-details', {roadId:'\${id}', isOneWay:\${!r.is_one_way}})">\${r.is_one_way ? 'Two-way' : 'One-way'}</button>
              </div>
            </div>
          </div>\`;
        }).join('') || '<div style="color:var(--text-muted);">No roads waiting.</div>';
        document.getElementById('mapReviewLandmarks').innerHTML = data.candidateLandmarks.map(l => {
          const id = escapeHtml(l.id);
          return \`<div style="padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);"><strong>\${escapeHtml(l.name)}</strong> <small style="color:var(--text-muted);">\${escapeHtml(l.locality || '')}, \${escapeHtml(l.region || '')}</small>
            <button class="action-btn" onclick="mapReviewAct('publish-landmark', {landmarkId:'\${id}'})">Publish</button>
            <button class="action-btn" onclick="mapReviewAct('reject', {type:'landmark', id:'\${id}', notes:'Rejected in map review'})">Reject</button></div>\`;
        }).join('') || '<div style="color:var(--text-muted);">No places waiting.</div>';
        document.getElementById('mapReviewPublished').innerHTML = data.recentlyPublished.map(v => {
          const road = v.change_type === 'road_publish';
          return \`<div style="padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.08);"><strong>\${escapeHtml(v.name || 'Unnamed')}</strong> <small style="color:var(--text-muted);">\${road ? 'Road' : 'Place'}, \${v.automatic ? 'published automatically' : 'published by staff'}, \${escapeHtml(new Date(v.created_at).toLocaleString())}</small>
            <button class="action-btn" onclick="mapReviewAct('\${road ? 'rollback-road' : 'rollback-landmark'}', {versionTag:'\${escapeHtml(v.version_tag)}'})">Undo</button></div>\`;
        }).join('') || '<div style="color:var(--text-muted);">Nothing published yet.</div>';
        document.getElementById('mapReviewScans').innerHTML = (data.imageryScans || []).map(s => \`<div style="padding:6px 0; font-size:13px;"><strong>\${escapeHtml(s.area_name)}</strong>: \${s.changed_cells} changed area(s). \${escapeHtml(s.outcome)}. \${escapeHtml(new Date(s.scanned_at).toLocaleDateString())}</div>\`).join('') || '<div style="color:var(--text-muted);">No scan has run yet.</div>';
      } catch (err) { alert(err.message); }
    }

    async function mapReviewAct(action, body) {
      try {
        await api('/api/v1/admin/geo-intelligence/' + action, { method: 'POST', body: JSON.stringify(body) });
        loadMapReview();
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
                <button class="action-btn" onclick="inspectSupportConversation('\${escapeHtml(r.conversation_id)}')">View chat</button>
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
            \${m.voiceNote ? (m.voiceNote.available ? \`<button class="action-btn" onclick="playSupportVoiceNote('\${escapeHtml(convId)}','\${escapeHtml(m.id)}',this)">Play voice note</button>\` : '<div style="font-size:12px; color:var(--text-muted);">Audio deleted</div>') : ''}
          </div>
        \`).join('') || '<div style="color:var(--text-muted);">No messages yet.</div>';
        document.getElementById('supportInspectorCard').style.display = 'block';
      } catch (err) { alert(err.message); }
    }

    async function playSupportVoiceNote(convId, messageId, button) {
      try {
        const response = await fetch(\`/api/v1/chat/conversations/\${convId}/messages/\${messageId}/audio\`, {
          headers: { 'Authorization': 'Bearer ' + token, 'X-Support-Justification': 'Support Queue Investigation' }
        });
        if (!response.ok) throw new Error('This voice note is no longer available');
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = URL.createObjectURL(await response.blob());
        button.replaceWith(audio);
        audio.play();
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
