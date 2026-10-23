/**
 * ELESEND Unified Cloud Portability & Configuration Module
 * 
 * Provides centralized, validated, and fail-fast environment configuration
 * supporting VPS, Docker, AWS ECS/RDS, GCP Cloud Run/SQL, Render, Railway, Fly.io,
 * and local development/test environments.
 */

import {isIP} from 'node:net';

export function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

export function parseInteger(value, defaultValue = null) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const raw=String(value).trim();
  if(!/^\d+$/.test(raw))return NaN;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : defaultValue;
}

export function parseJson(value, fallback = null) {
  if (!value || typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value.trim());
  } catch {
    return fallback;
  }
}

export function isLoopbackOrPrivateIp(host) {
  if (!host) return false;
  const clean = host.split(':')[0].toLowerCase();
  if (clean === 'localhost' || clean === '127.0.0.1' || clean === '::1' || clean === '10.0.2.2') return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  return false;
}

/**
 * Validates the raw environment dictionary and returns structured configuration.
 * Does not throw on failure; returns { ok, config, errors }.
 */
export function validateConfig(env = process.env) {
  const errors = [];
  const warnings = [];

  const nodeEnv = (env.NODE_ENV || 'development').trim().toLowerCase();
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';
  const isStaging = nodeEnv === 'staging';

  // --- Database Settings ---
  const dbUrl = (env.DATABASE_URL || env.DOCKER_DATABASE_URL || '').trim();
  if (!dbUrl && (isProduction || isStaging)) {
    errors.push('DATABASE_URL is required in production/staging.');
  }

  // Detect SSL from env or connection string
  const rawSsl = env.DATABASE_SSL ? String(env.DATABASE_SSL).trim().toLowerCase() : '';
  const urlLower = dbUrl.toLowerCase();
  const urlWantsSsl = urlLower.includes('sslmode=require') || 
                      urlLower.includes('sslmode=verify-full') || 
                      urlLower.includes('sslmode=verify-ca') ||
                      urlLower.includes('ssl=true');
  
  let sslEnabled = false;
  if (rawSsl === 'true' || rawSsl === '1' || rawSsl === 'require') {
    sslEnabled = true;
  } else if (rawSsl === 'false' || rawSsl === '0' || rawSsl === 'disable') {
    sslEnabled = false;
  } else {
    sslEnabled = urlWantsSsl;
  }

  const rejectUnauthorized = env.DATABASE_SSL_REJECT_UNAUTHORIZED !== undefined
    ? parseBoolean(env.DATABASE_SSL_REJECT_UNAUTHORIZED, true)
    : true;

  const dbConfig = {
    url: dbUrl,
    ssl: {
      enabled: sslEnabled,
      rejectUnauthorized,
      ca: env.DATABASE_SSL_CA ? env.DATABASE_SSL_CA.trim() : null
    }
  };

  // --- Server & Network ---
  const port = parseInteger(env.PORT, 3090);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    errors.push(`Invalid PORT "${env.PORT}": must be an integer between 1 and 65535.`);
  }

  const defaultHost = isProduction ? '0.0.0.0' : '127.0.0.1';
  const host = (env.HOST || defaultHost).trim();

  const trustedProxyCidrs = (env.TRUSTED_PROXY_CIDRS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const readinessProbeToken = (env.READINESS_PROBE_TOKEN || '').trim() || null;
  if (isProduction && readinessProbeToken && readinessProbeToken.length < 32) {
    errors.push('READINESS_PROBE_TOKEN must be at least 32 characters in production.');
  }

  // --- Origins & Isolation ---
  const apiPublicOrigin = (env.API_PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
  const webPublicOrigin = (env.WEB_PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
  const adminHost = env.ADMIN_HOST ? env.ADMIN_HOST.split(':')[0].trim().toLowerCase() : null;

  if (adminHost) {
    if (adminHost.includes('/') || (adminHost.includes(':') && !/^\d+$/.test(adminHost.split(':')[1])) || /[\s<>"`\\@]/.test(adminHost)) {
      errors.push(`ADMIN_HOST "${adminHost}" is not a valid hostname.`);
    }
  }

  for (const [name, value] of [['API_PUBLIC_ORIGIN', apiPublicOrigin], ['WEB_PUBLIC_ORIGIN', webPublicOrigin]]) {
    if (isProduction && !value) {
      errors.push(`${name} is required in production.`);
    } else if (value) {
      try {
        const u = new URL(value);
        if (isProduction && u.protocol !== 'https:') {
          errors.push(`${name} must use HTTPS in production (got "${u.protocol}").`);
        } else if (!['http:', 'https:'].includes(u.protocol)) {
          errors.push(`${name} must use http: or https: (got "${u.protocol}").`);
        } else if (u.username || u.password) {
          errors.push(`${name} must not contain user credentials.`);
        } else if (u.pathname && u.pathname !== '/' && u.pathname !== '') {
          errors.push(`${name} must be an origin without a path component (got "${u.pathname}").`);
        } else if (u.search) {
          errors.push(`${name} must not contain a query string.`);
        } else if (u.hash) {
          errors.push(`${name} must not contain a URL hash/fragment.`);
        } else if (!u.hostname || /[\s<>"`\\]/.test(u.hostname)) {
          errors.push(`${name} contains an invalid hostname.`);
        }
      } catch {
        errors.push(`${name} must be a valid URL (got "${value}").`);
      }
    }
  }

  const optionalOriginOverrides = [
    ['HUBTEL_CALLBACK_BASE_URL', (env.HUBTEL_CALLBACK_BASE_URL || '').trim()],
    ['HUBTEL_RETURN_BASE_URL', (env.HUBTEL_RETURN_BASE_URL || '').trim()],
    ['HUBTEL_CANCELLATION_BASE_URL', (env.HUBTEL_CANCELLATION_BASE_URL || '').trim()]
  ];
  for (const [name, val] of optionalOriginOverrides) {
    if (val) {
      try {
        const u = new URL(val);
        if (isProduction && u.protocol !== 'https:') {
          errors.push(`${name} must use HTTPS in production (got "${u.protocol}").`);
        } else if (!['http:', 'https:'].includes(u.protocol)) {
          errors.push(`${name} must use http: or https: (got "${u.protocol}").`);
        } else if (u.username || u.password) {
          errors.push(`${name} must not contain user credentials.`);
        } else if (u.pathname && u.pathname !== '/' && u.pathname !== '') {
          errors.push(`${name} must be an origin without a path component (got "${u.pathname}").`);
        } else if (u.search) {
          errors.push(`${name} must not contain a query string.`);
        } else if (u.hash) {
          errors.push(`${name} must not contain a URL hash/fragment.`);
        } else if (!u.hostname || /[\s<>"`\\]/.test(u.hostname)) {
          errors.push(`${name} contains an invalid hostname.`);
        }
      } catch {
        errors.push(`${name} must be a valid URL (got "${val}").`);
      }
    }
  }

  // Fallbacks for origins (NEVER fall back to hardcoded production domains)
  const effectiveApiOrigin = apiPublicOrigin || (isProduction ? '' : `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);
  const effectiveWebOrigin = webPublicOrigin || (isProduction ? '' : `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`);

  // --- Security Keys ---
  const otpKey = (env.OTP_KEY || '').trim();
  const adminMfaKey = (env.ADMIN_MFA_ENCRYPTION_KEY || '').trim();
  const jwtSecret = (env.JWT_SECRET || '').trim();
  const adminMasterKey = (env.ADMIN_MASTER_KEY || '').trim();
  const auditLogSecret = (env.AUDIT_LOG_SECRET || '').trim();

  if (isProduction) {
    if (!/^[a-fA-F0-9]{64}$/.test(otpKey)) {
      errors.push('OTP_KEY must be exactly 64 hexadecimal characters (32 bytes) in production.');
    }
    if (!/^[a-fA-F0-9]{64}$/.test(adminMfaKey)) {
      errors.push('ADMIN_MFA_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes) in production.');
    }
    if (otpKey && adminMfaKey && otpKey.toLowerCase() === adminMfaKey.toLowerCase()) {
      errors.push('OTP_KEY and ADMIN_MFA_ENCRYPTION_KEY must be independent random keys.');
    }
    if (jwtSecret && jwtSecret.length < 32) {
      errors.push('JWT_SECRET must be at least 32 characters in production.');
    }
    if (adminMasterKey && adminMasterKey.length < 32) {
      errors.push('ADMIN_MASTER_KEY must be at least 32 characters in production.');
    }
    if (auditLogSecret && auditLogSecret.length < 32) {
      errors.push('AUDIT_LOG_SECRET must be at least 32 characters in production.');
    }

    const keyList = [
      { name: 'OTP_KEY', val: otpKey.toLowerCase() },
      { name: 'ADMIN_MFA_ENCRYPTION_KEY', val: adminMfaKey.toLowerCase() },
      { name: 'JWT_SECRET', val: jwtSecret },
      { name: 'ADMIN_MASTER_KEY', val: adminMasterKey },
      { name: 'AUDIT_LOG_SECRET', val: auditLogSecret }
    ].filter(k => k.val);

    for (let i = 0; i < keyList.length; i++) {
      for (let j = i + 1; j < keyList.length; j++) {
        if (keyList[i].val === keyList[j].val) {
          errors.push(`${keyList[i].name} and ${keyList[j].name} must be distinct independent cryptographic keys.`);
        }
      }
    }
  }

  // --- Background Jobs & Execution Plan ---
  const backgroundJobsEnabled = env.BACKGROUND_JOBS_ENABLED !== undefined
    ? parseBoolean(env.BACKGROUND_JOBS_ENABLED, true)
    : true;

  // --- Routing & OSRM ---
  const rawVehiclesJson = parseJson(env.ROUTING_OSRM_VEHICLES_JSON, null);
  if(env.ROUTING_OSRM_VEHICLES_JSON&&!rawVehiclesJson)errors.push('ROUTING_OSRM_VEHICLES_JSON must be valid JSON.');
  let assembledVehicleRoutes = rawVehiclesJson && typeof rawVehiclesJson === 'object' && !Array.isArray(rawVehiclesJson)
    ? { ...rawVehiclesJson }
    : null;

  // Check vehicle-specific environment variables (e.g. ROUTING_OSRM_MOTORCYCLE_URL, ROUTING_OSRM_CAR_URL)
  const carUrl = (env.ROUTING_OSRM_CAR_URL || '').trim();
  const motorcycleUrl = (env.ROUTING_OSRM_MOTORCYCLE_URL || '').trim();
  const osrmUrl = (env.ROUTING_OSRM_URL || '').trim() || null;

  const routingUrls = [
    ['ROUTING_OSRM_URL', osrmUrl],
    ['ROUTING_OSRM_CAR_URL', carUrl],
    ['ROUTING_OSRM_MOTORCYCLE_URL', motorcycleUrl]
  ];
  for (const [name, val] of routingUrls) {
    if (val) {
      try {
        const u = new URL(val);
        if (!['http:', 'https:'].includes(u.protocol)) {
          errors.push(`${name} must use http: or https: (got "${u.protocol}").`);
        } else if (u.username || u.password) {
          errors.push(`${name} must not contain user credentials.`);
        }
      } catch {
        errors.push(`${name} must be a valid URL (got "${val}").`);
      }
    }
  }

  if (carUrl || motorcycleUrl) {
    assembledVehicleRoutes = assembledVehicleRoutes || {};
    if (carUrl) assembledVehicleRoutes.car = {endpoint:carUrl,profile:'driving'};
    if (motorcycleUrl) assembledVehicleRoutes.motorcycle = {endpoint:motorcycleUrl,profile:'driving'};
  }

  const defaultProfiles = { car: 'driving', motorcycle: 'driving' };
  let profiles = defaultProfiles;
  if (env.ROUTING_OSRM_PROFILES_JSON && env.ROUTING_OSRM_PROFILES_JSON.trim()) {
    try {
      profiles = JSON.parse(env.ROUTING_OSRM_PROFILES_JSON);
    } catch {
      errors.push('ROUTING_OSRM_PROFILES_JSON must be valid JSON.');
      profiles = defaultProfiles;
    }
  }

  const allowSingleEndpoint = parseBoolean(env.ROUTING_ALLOW_SINGLE_ENDPOINT, !isProduction);

  if (isProduction && !assembledVehicleRoutes && !allowSingleEndpoint) {
    const hasNonCar = Object.keys(profiles).some(v => v !== 'car');
    if (hasNonCar) {
      errors.push('Use independent OSRM graph endpoints for non-car vehicles (set ROUTING_OSRM_VEHICLES_JSON or ROUTING_OSRM_MOTORCYCLE_URL), or set ROUTING_ALLOW_SINGLE_ENDPOINT=true.');
    }
  }

  const routingConfig = {
    osrmUrl,
    vehicleRoutes: assembledVehicleRoutes,
    profiles,
    allowSingleEndpoint,
    ghanaPostGpsLookupEnabled: parseBoolean(env.GHANAPOSTGPS_LOOKUP_ENABLED, false),
    ghanaPostGpsLookupUrl: (env.GHANAPOSTGPS_LOOKUP_URL || 'https://ghanapostgps.sperixlabs.org').trim()
  };

  // --- Payment Provider Selection & Configuration ---
  const rawPaymentProvider = (env.PAYMENT_PROVIDER || 'none').trim().toLowerCase();
  let paymentProviderName = null;

  const hubtelClientId = (env.HUBTEL_CLIENT_ID || '').trim();
  const hubtelClientSecret = (env.HUBTEL_CLIENT_SECRET || '').trim();
  const hubtelMerchantNo = (env.HUBTEL_MERCHANT_ACCOUNT_NUMBER || '').trim();
  const paystackSecretKey = (env.PAYSTACK_SECRET_KEY || '').trim();

  if (rawPaymentProvider === 'hubtel') {
    paymentProviderName = 'hubtel';
    if (!hubtelClientId || !hubtelClientSecret || !hubtelMerchantNo) {
      errors.push('PAYMENT_PROVIDER is set to "hubtel", but HUBTEL_CLIENT_ID, HUBTEL_CLIENT_SECRET, or HUBTEL_MERCHANT_ACCOUNT_NUMBER is missing.');
    }
  } else if (rawPaymentProvider === 'paystack') {
    paymentProviderName = 'paystack';
    if (!paystackSecretKey) {
      errors.push('PAYMENT_PROVIDER is set to "paystack", but PAYSTACK_SECRET_KEY is missing.');
    }
   } else if(rawPaymentProvider==='gateway'){
    paymentProviderName='gateway';
    for(const key of ['PAYMENT_GATEWAY_NAME','PAYMENT_GATEWAY_ENDPOINT','PAYMENT_GATEWAY_ALLOWED_HOST','PAYMENT_GATEWAY_TOKEN','PAYMENT_GATEWAY_CHECKOUT_HOSTS'])if(!env[key]?.trim())errors.push(key+' is required for the configured payment bridge.');
  } else if (rawPaymentProvider === 'none') {
    paymentProviderName = null;
  } else if (rawPaymentProvider === 'auto') {
    if(isProduction)errors.push('Select PAYMENT_PROVIDER explicitly in production; automatic provider switching is disabled.');
    if (hubtelClientId && hubtelClientSecret && hubtelMerchantNo) {
      paymentProviderName = 'hubtel';
    } else if (paystackSecretKey) {
      paymentProviderName = 'paystack';
    } else {
      paymentProviderName = null;
    }
  } else {
    errors.push(`Unknown PAYMENT_PROVIDER "${env.PAYMENT_PROVIDER}". Valid values: 'gateway', 'hubtel', 'paystack', 'none' (auto is development-only).`);
  }

  // Payment URLs & Options
  const hubtelPaymentConfig = (paymentProviderName === 'hubtel' || (hubtelClientId && hubtelClientSecret && hubtelMerchantNo))
    ? {
        clientId: hubtelClientId,
        clientSecret: hubtelClientSecret,
        merchantAccountNumber: hubtelMerchantNo,
        endpoint: (env.HUBTEL_PAYMENT_ENDPOINT || 'https://payproxyapi.hubtel.com').trim(),
        allowedHost: (env.HUBTEL_PAYMENT_ALLOWED_HOST || 'payproxyapi.hubtel.com').trim(),
        allowedMethods: (env.HUBTEL_ENABLED_METHODS || 'MOMO,CARD,QR').split(',').map(s => s.trim()).filter(Boolean),
        callbackBaseUrl: (env.HUBTEL_CALLBACK_BASE_URL || effectiveApiOrigin).trim(),
        returnBaseUrl: (env.HUBTEL_RETURN_BASE_URL || effectiveWebOrigin).trim(),
        cancellationBaseUrl: (env.HUBTEL_CANCELLATION_BASE_URL || env.HUBTEL_RETURN_BASE_URL || effectiveWebOrigin).trim(),
        receivingAccount: (env.SETTLEMENT_HUBTEL_RECEIVING_ACCOUNT || '').trim() || null,
        providerChannel: (env.SETTLEMENT_HUBTEL_PROVIDER_CHANNEL || '').trim() || null
      }
    : null;

  const paystackPaymentConfig = (paymentProviderName === 'paystack' || paystackSecretKey)
    ? {
        secretKey: paystackSecretKey,
        allowedMethods: (env.PAYSTACK_ENABLED_METHODS || 'MOMO,CARD').split(',').map(s => s.trim()).filter(Boolean),
        recipientType: (env.SETTLEMENT_PAYSTACK_RECIPIENT_TYPE || '').trim() || null,
        providerChannel: (env.SETTLEMENT_PAYSTACK_PROVIDER_CHANNEL || '').trim() || null
      }
    : null;

  // --- SMS Provider Selection & Configuration ---
  const rawSmsProvider = (env.SMS_PROVIDER || 'auto').trim().toLowerCase();
  let smsProviderName = null;
  const smsGatewayEndpoint = (env.SMS_GATEWAY_ENDPOINT || '').trim();
  const smsGatewayAllowedHost = (env.SMS_GATEWAY_ALLOWED_HOST || '').trim();
  const smsGatewayToken = (env.SMS_GATEWAY_TOKEN || '').trim();

  if (rawSmsProvider === 'hubtel') {
    smsProviderName = 'hubtel';
    if (!hubtelClientId || !hubtelClientSecret) {
      errors.push('SMS_PROVIDER is set to "hubtel", but HUBTEL_CLIENT_ID or HUBTEL_CLIENT_SECRET is missing.');
    }
  } else if (rawSmsProvider === 'https_gateway') {
    smsProviderName = 'https_gateway';
  } else if (rawSmsProvider === 'none') {
    smsProviderName = null;
  } else if (rawSmsProvider === 'auto') {
    if (hubtelClientId && hubtelClientSecret) {
      smsProviderName = 'hubtel';
    } else if (smsGatewayEndpoint) {
      smsProviderName = 'https_gateway';
    } else {
      smsProviderName = null;
    }
  } else {
    errors.push(`Unknown SMS_PROVIDER "${env.SMS_PROVIDER}". Valid values: 'hubtel', 'https_gateway', 'none', 'auto'.`);
  }

  if (smsProviderName === 'https_gateway') {
    if (!smsGatewayEndpoint) {
      errors.push('SMS_PROVIDER is set to "https_gateway", but SMS_GATEWAY_ENDPOINT is missing.');
    } else {
      let parsedSmsUrl = null;
      try {
        parsedSmsUrl = new URL(smsGatewayEndpoint);
      } catch {
        errors.push('SMS_GATEWAY_ENDPOINT must be a valid URL.');
      }
      if (parsedSmsUrl) {
        if (
          parsedSmsUrl.protocol !== 'https:'
          || parsedSmsUrl.username
          || parsedSmsUrl.password
          || parsedSmsUrl.port
          || parsedSmsUrl.search
          || parsedSmsUrl.hash
          || isIP(parsedSmsUrl.hostname) !== 0
          || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(parsedSmsUrl.hostname)
          || parsedSmsUrl.hostname.endsWith('.local')
        ) {
          errors.push('SMS_GATEWAY_ENDPOINT must be an approved HTTPS URL without credentials, port, query, fragment, IP, or local host.');
        } else if (smsGatewayAllowedHost && parsedSmsUrl.hostname !== smsGatewayAllowedHost) {
          errors.push('SMS_GATEWAY_ALLOWED_HOST must match the hostname of SMS_GATEWAY_ENDPOINT.');
        }
      }
    }
    if (!smsGatewayAllowedHost) {
      errors.push('SMS_PROVIDER is set to "https_gateway", but SMS_GATEWAY_ALLOWED_HOST is missing.');
    }
    if (!smsGatewayToken || smsGatewayToken.length < 16) {
      errors.push('SMS_PROVIDER is set to "https_gateway", but SMS_GATEWAY_TOKEN is missing or shorter than 16 characters.');
    }
  }

  const hubtelSmsConfig = (smsProviderName === 'hubtel' || (hubtelClientId && hubtelClientSecret))
    ? {
        clientId: hubtelClientId,
        clientSecret: hubtelClientSecret,
        senderId: (env.HUBTEL_SENDER_ID || 'ELESEND').trim(),
        endpoint: (env.HUBTEL_SMS_ENDPOINT || 'https://api.hubtel.com/v1/messages/send').trim()
      }
    : null;

  const httpsGatewaySmsConfig = (smsProviderName === 'https_gateway' || smsGatewayEndpoint)
    ? {
        endpoint: smsGatewayEndpoint,
        allowedHost: smsGatewayAllowedHost || null,
        token: smsGatewayToken || null
      }
    : null;

  // Build the validated config structure
  const config = {
    env: nodeEnv,
    isProduction,
    isStaging,
    isTest,
    server: {
      host,
      port,
      trustedProxyCidrs,
      readinessProbeToken,
      backgroundJobsEnabled
    },
    origins: {
      apiPublicOrigin: effectiveApiOrigin,
      webPublicOrigin: effectiveWebOrigin,
      adminHost
    },
    database: dbConfig,
    security: {
      otpKey,
      adminMfaEncryptionKey: adminMfaKey,
      jwtSecret,
      adminMasterKey,
      auditLogSecret,
      enablePrepaidCredits: parseBoolean(env.ENABLE_PREPAID_CREDITS, false)
    },
    routing: routingConfig,
    payment: {
      provider: paymentProviderName,
      hubtel: hubtelPaymentConfig,
      paystack: paystackPaymentConfig,
      gateway: {name:env.PAYMENT_GATEWAY_NAME,endpoint:env.PAYMENT_GATEWAY_ENDPOINT,allowedHost:env.PAYMENT_GATEWAY_ALLOWED_HOST,token:env.PAYMENT_GATEWAY_TOKEN,methods:(env.PAYMENT_GATEWAY_METHODS||'MOMO,CARD').split(',').map(x=>x.trim()),checkoutHosts:(env.PAYMENT_GATEWAY_CHECKOUT_HOSTS||'').split(',').map(x=>x.trim()).filter(Boolean),payerFields:(env.PAYMENT_PAYER_FIELDS||'').split(',').map(x=>x.trim()).filter(Boolean)}
    },
    sms: {
      provider: smsProviderName,
      hubtel: hubtelSmsConfig,
      httpsGateway: httpsGatewaySmsConfig
    },
    notifications: {
      endpoint: (env.NOTIFICATION_GATEWAY_ENDPOINT || '').trim(),
      allowedHost: (env.NOTIFICATION_GATEWAY_ALLOWED_HOST || '').trim(),
      token: env.NOTIFICATION_GATEWAY_TOKEN || ''
    },
    food: {
      acceptanceTimeoutSeconds:parseInteger(env.FOOD_ACCEPTANCE_TIMEOUT_SECONDS,300),
      courierTimeoutSeconds:parseInteger(env.FOOD_COURIER_TIMEOUT_SECONDS,1200),
      unpaidTimeoutSeconds:parseInteger(env.FOOD_PAYMENT_TIMEOUT_SECONDS,1800)
    }
  };

  return {
    ok: errors.length === 0,
    config,
    errors,
    warnings
  };
}

/**
 * Loads and validates configuration from environment, failing fast with a clean
 * error message if validation fails in production or strict mode.
 */
export function loadConfig(env = process.env, { strict = null } = {}) {
  const result = validateConfig(env);
  const shouldBeStrict = strict ?? result.config.isProduction;

  if (!result.ok && shouldBeStrict) {
    const header = `[FATAL] ELESEND configuration validation failed with ${result.errors.length} error(s):`;
    const details = result.errors.map(err => `  - ${err}`).join('\n');
    throw new Error(`${header}\n${details}`);
  }

  return result.config;
}
