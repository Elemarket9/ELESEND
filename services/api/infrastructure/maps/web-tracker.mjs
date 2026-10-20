import {haversine} from '../../dispatch-geometry.mjs';

export function statusToLabel(state){
 switch(state){
  case 'AWAITING_PAYMENT': return 'Awaiting payment confirmation';
  case 'AWAITING_ASSIGNMENT': return 'Finding nearest available courier';
  case 'RIDER_ASSIGNED': return 'Courier assigned and en route to pickup';
  case 'PICKUP_VERIFIED': return 'Package collected, preparing transport';
  case 'IN_TRANSIT': return 'On the way to delivery';
  case 'AWAITING_DELIVERY_OTP': return 'Courier arrived at delivery location';
  case 'COMPLETED': return 'Delivered successfully';
  case 'CANCELLED': return 'Order cancelled';
  case 'FAILED': return 'Delivery paused / issue reported';
  case 'RETURN_REQUESTED': return 'Return in progress';
  case 'RETURNED': return 'Returned to sender';
  default: return 'Processing shipment';
 }
}

export async function getPublicTracking(db, token){
 if(!token||typeof token!=='string')return null;
 const clean=token.trim();
 if(!/^[0-9a-f-]{36}$/i.test(clean))return null;

 const query=`
  SELECT s.id, s.state, s.amount_minor, s.created_at, s.completed_at,
         q.request,
         l.latitude AS courier_lat, l.longitude AS courier_lon, l.updated_at AS courier_time,
         r.vehicle AS rider_vehicle
  FROM shipments s
  JOIN quotes q ON q.id=s.quote_id
  LEFT JOIN locations l ON l.shipment_id=s.id
  LEFT JOIN riders r ON r.id=s.rider_id
  WHERE s.id=$1
 `;

 const res=await db.query(query,[clean]);
 if(!res.rows.length)return null;
 const row=res.rows[0];
 const req=row.request||{};

 const courier=Number.isFinite(row.courier_lat)&&Number.isFinite(row.courier_lon)?{
  latitude:row.courier_lat,
  longitude:row.courier_lon,
  updatedAt:row.courier_time,
  vehicle:row.rider_vehicle||req.vehicle||'motorcycle'
 }:null;

 let etaEstimate=null;
 if(courier&&req.destination&&['IN_TRANSIT','AWAITING_DELIVERY_OTP'].includes(row.state)){
  const distMeters=haversine(courier,req.destination);
  const mins=Math.max(1,Math.round((distMeters/1000)/(courier.vehicle==='motorcycle'?28:22)*60));
  etaEstimate={
   remainingDistanceKm:Math.round(distMeters/100)/10,
   estimatedMinutes:mins
  };
 }

 return {
  shipmentId:row.id,
  state:row.state,
  statusLabel:statusToLabel(row.state),
  vehicle:courier?.vehicle||req.vehicle||'motorcycle',
  pickup:req.pickup?{address:req.pickup.address||'Pickup Location',latitude:req.pickup.latitude,longitude:req.pickup.longitude}:null,
  destination:req.destination?{address:req.destination.address||'Delivery Destination',latitude:req.destination.latitude,longitude:req.destination.longitude}:null,
  courier,
  eta:etaEstimate,
  createdAt:row.created_at,
  completedAt:row.completed_at
 };
}

export function renderTrackingHtml(data){
 const safeData=JSON.stringify(data).replace(/</g,'\\u003c');
 const steps=['AWAITING_ASSIGNMENT','RIDER_ASSIGNED','IN_TRANSIT','COMPLETED'];
 const stateIndex=steps.indexOf(data.state);
 const activeStep=stateIndex===-1?(data.state==='PICKUP_VERIFIED'?1:data.state==='AWAITING_DELIVERY_OTP'?2:0):stateIndex;

 return `<!DOCTYPE html>
<html lang="en">
<head>
 <meta charset="UTF-8">
 <meta name="viewport" content="width=device-width, initial-scale=1.0">
 <title>ELESEND Live Tracking • ${data.shipmentId.slice(0,8)}</title>
 <style>
  :root {
   --bg: #0c1324;
   --panel: #172239;
   --line: #30415f;
   --light: #eef5ff;
   --muted: #a5b6d0;
   --accent: #3fd6b3;
   --warn: #ffb356;
   --success: #2ecc71;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  body { background: var(--bg); color: var(--light); min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 16px; }
  .container { width: 100%; max-width: 480px; display: flex; flex-direction: column; gap: 16px; }
  .header { display: flex; justify-content: space-between; align-items: center; padding: 12px 4px; }
  .brand { font-size: 24px; font-weight: 900; letter-spacing: 2px; color: var(--accent); }
  .badge { background: #214a55; color: var(--accent); font-size: 12px; font-weight: 700; padding: 6px 12px; border-radius: 20px; border: 1px solid var(--accent); }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 18px; padding: 18px; }
  .status-title { font-size: 18px; font-weight: 800; color: #fff; margin-bottom: 6px; }
  .status-subtitle { font-size: 13px; color: var(--muted); line-height: 1.4; }
  
  /* Timeline stepper */
  .stepper { display: flex; justify-content: space-between; margin: 20px 0 10px; position: relative; }
  .stepper::before { content: ""; position: absolute; top: 12px; left: 10px; right: 10px; height: 2px; background: var(--line); z-index: 1; }
  .step-node { position: relative; z-index: 2; display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .dot { width: 24px; height: 24px; border-radius: 50%; background: var(--line); border: 3px solid var(--panel); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: bold; }
  .step-node.done .dot { background: var(--accent); color: #071b28; }
  .step-node.active .dot { background: var(--accent); box-shadow: 0 0 12px var(--accent); }
  .step-label { font-size: 11px; color: var(--muted); }
  .step-node.active .step-label { color: var(--accent); font-weight: 700; }

  /* Map Container */
  .map-wrapper { height: 260px; border-radius: 14px; overflow: hidden; background: #131d31; border: 1px solid var(--line); position: relative; }
  svg.map-canvas { width: 100%; height: 100%; }

  .eta-card { display: flex; align-items: center; justify-content: space-between; background: #1f2d4a; padding: 12px 16px; border-radius: 12px; margin-top: 12px; }
  .eta-time { font-size: 22px; font-weight: 900; color: var(--accent); }
  .eta-label { font-size: 12px; color: var(--muted); }

  .address-row { display: flex; gap: 12px; margin: 12px 0; align-items: flex-start; }
  .icon-pin { width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold; flex-shrink: 0; margin-top: 2px; }
  .pin-p { background: #2ecc71; color: #fff; }
  .pin-d { background: #e74c3c; color: #fff; }
  .address-text { font-size: 14px; color: var(--light); line-height: 1.4; }
  .address-role { font-size: 11px; color: var(--muted); text-transform: uppercase; font-weight: bold; }

  .footer { text-align: center; font-size: 12px; color: var(--muted); padding: 16px 0; }
  .pulse { animation: pulse-anim 2s infinite; }
  @keyframes pulse-anim { 0% { transform: scale(0.95); opacity: 0.9; } 50% { transform: scale(1.15); opacity: 0.4; } 100% { transform: scale(0.95); opacity: 0.9; } }
 </style>
</head>
<body>
 <div class="container">
  <div class="header">
   <div class="brand">ELESEND</div>
   <div class="badge" id="state-badge">${data.state.replace(/_/g, ' ')}</div>
  </div>

  <div class="card">
   <div class="status-title" id="status-label">${data.statusLabel}</div>
   <div class="status-subtitle" id="status-desc">Order #${data.shipmentId.slice(0, 8)} • Verified road delivery</div>

   <div class="stepper">
    <div class="step-node ${activeStep>=0?'done':''} ${activeStep===0?'active':''}">
     <div class="dot">1</div>
     <div class="step-label">Placed</div>
    </div>
    <div class="step-node ${activeStep>=1?'done':''} ${activeStep===1?'active':''}">
     <div class="dot">2</div>
     <div class="step-label">Assigned</div>
    </div>
    <div class="step-node ${activeStep>=2?'done':''} ${activeStep===2?'active':''}">
     <div class="dot">3</div>
     <div class="step-label">In Transit</div>
    </div>
    <div class="step-node ${activeStep>=3?'done':''} ${activeStep===3?'active':''}">
     <div class="dot">4</div>
     <div class="step-label">Delivered</div>
    </div>
   </div>

   ${data.eta?`
   <div class="eta-card" id="eta-box">
    <div>
     <div class="eta-label">ESTIMATED ARRIVAL</div>
     <div class="status-subtitle">${data.eta.remainingDistanceKm} km remaining</div>
    </div>
    <div class="eta-time">${data.eta.estimatedMinutes} mins</div>
   </div>`:''}
  </div>

  <div class="card" style="padding: 10px;">
   <div class="map-wrapper" id="map-box">
    <svg class="map-canvas" id="map-svg" viewBox="0 0 400 260">
     <!-- Synthetic SVG grid & road line representation -->
     <defs>
      <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
       <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1d2a45" stroke-width="1"/>
      </pattern>
     </defs>
     <rect width="100%" height="100%" fill="url(#grid)" />
     <path id="route-line" d="M 60 200 Q 200 60 340 70" fill="none" stroke="#3fd6b3" stroke-width="4" stroke-linecap="round" stroke-dasharray="8 4"/>
     <!-- Pickup Marker -->
     <g id="pickup-marker" transform="translate(60, 200)">
      <circle r="12" fill="#2ecc71" opacity="0.3"/>
      <circle r="7" fill="#2ecc71"/>
      <text y="-12" font-size="11" fill="#2ecc71" text-anchor="middle" font-weight="bold">Pickup</text>
     </g>
     <!-- Dropoff Marker -->
     <g id="dropoff-marker" transform="translate(340, 70)">
      <circle r="12" fill="#e74c3c" opacity="0.3"/>
      <circle r="7" fill="#e74c3c"/>
      <text y="-12" font-size="11" fill="#e74c3c" text-anchor="middle" font-weight="bold">Dropoff</text>
     </g>
     <!-- Courier Marker -->
     <g id="courier-marker" transform="translate(190, 115)">
      <circle class="pulse" r="18" fill="#3fd6b3" opacity="0.4"/>
      <circle r="10" fill="#172239" stroke="#3fd6b3" stroke-width="2"/>
      <text y="4" font-size="11" fill="#3fd6b3" text-anchor="middle">${data.vehicle==='car'?'🚗':'🛵'}</text>
     </g>
    </svg>
   </div>
  </div>

  <div class="card">
   <div class="address-row">
    <div class="icon-pin pin-p">P</div>
    <div>
     <div class="address-role">Pickup Address</div>
     <div class="address-text">${data.pickup?.address||'Specified pickup location'}</div>
    </div>
   </div>
   <div style="border-top: 1px solid var(--line); margin: 8px 0 8px 32px;"></div>
   <div class="address-row">
    <div class="icon-pin pin-d">D</div>
    <div>
     <div class="address-role">Destination</div>
     <div class="address-text">${data.destination?.address||'Specified dropoff location'}</div>
    </div>
   </div>
  </div>

  <div class="footer">
   ELESEND Ghana • Independent logistics network • Live telemetry
  </div>
 </div>

 <script>
  const token = ${JSON.stringify(data.shipmentId)};
  // Auto-refresh every 6 seconds to update courier position and status
  async function pollStatus() {
   try {
    const res = await fetch('/api/v1/public-track/' + token);
    if (!res.ok) return;
    const fresh = await res.json();
    document.getElementById('state-badge').innerText = fresh.state.replace(/_/g, ' ');
    document.getElementById('status-label').innerText = fresh.statusLabel;
    if (fresh.eta && document.getElementById('eta-box')) {
     document.getElementById('eta-box').innerHTML = '<div><div class="eta-label">ESTIMATED ARRIVAL</div><div class="status-subtitle">' + fresh.eta.remainingDistanceKm + ' km remaining</div></div><div class="eta-time">' + fresh.eta.estimatedMinutes + ' mins</div>';
    }
   } catch(e) {}
  }
  setInterval(pollStatus, 6000);
 </script>
</body>
</html>`;
}
