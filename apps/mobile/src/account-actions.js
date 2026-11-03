import { useState } from 'react';
import { call } from './api';
import { isValidGhanaPhone, normalizeGhanaPhone } from './phone';

/** Runs one action at a time and shows its error, the same way in both apps. */
export async function runGuarded(task, { busy, setBusy, setError }) {
  if (busy) return;
  setBusy(true);
  try {
    setError('');
    await task();
  } catch (e) {
    setError(e.message || 'Operation failed');
  } finally {
    setBusy(false);
  }
}

/** Password recovery, shared by the customer and rider apps. */
export function useAccountRecovery({ credentials, setCredentials, setError }) {
  const [forgotModal, setForgotModal] = useState(false);
  const [recoveryPhone, setRecoveryPhone] = useState('');
  const [recoveryChallenge, setRecoveryChallenge] = useState(null);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryNewPassword, setRecoveryNewPassword] = useState('');

  const validPhone = () => {
    const normPhone = normalizeGhanaPhone(recoveryPhone || credentials.phone);
    if (!isValidGhanaPhone(normPhone)) throw Error('Enter a valid registered Ghana mobile number');
    return normPhone;
  };

  async function requestPasswordRecoveryChallenge() {
    const normPhone = validPhone();
    const challenge = await call('POST', '/api/v1/auth/password-recovery', { phone: normPhone });
    setRecoveryPhone(normPhone);
    setRecoveryChallenge(challenge);
    setRecoveryCode('');
    setError('6-digit password recovery code sent via SMS to ' + normPhone);
  }

  async function submitPasswordReset() {
    const normPhone = validPhone();
    if (!recoveryChallenge?.challengeId) throw Error('Request a 6-digit recovery code first');
    if (!/^\d{6}$/.test(recoveryCode.trim())) throw Error('Enter the 6-digit SMS recovery code');
    if (recoveryNewPassword.length < 12 || recoveryNewPassword.length > 128) {
      throw Error('New password must be between 12 and 128 characters');
    }
    await call('POST', '/api/v1/auth/password-reset', {
      phone: normPhone,
      challengeId: recoveryChallenge.challengeId,
      code: recoveryCode.trim(),
      newPassword: recoveryNewPassword
    });
    setForgotModal(false);
    setRecoveryChallenge(null);
    setRecoveryCode('');
    setRecoveryNewPassword('');
    setCredentials(c => ({ ...c, phone: normPhone, password: '' }));
    setError('Password reset complete. All previous sessions have been revoked. Sign in with your new password.');
  }

  return {
    forgotModal, setForgotModal, recoveryPhone, setRecoveryPhone, recoveryChallenge, setRecoveryChallenge,
    recoveryCode, setRecoveryCode, recoveryNewPassword, setRecoveryNewPassword,
    requestPasswordRecoveryChallenge, submitPasswordReset
  };
}
