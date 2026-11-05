import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { AudioModule, AudioQuality, IOSOutputFormat, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioRecorder } from 'expo-audio';
import { EncodingType, readAsStringAsync } from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import { BASE, call, loadToken } from '../api';

const MAX_SECONDS = 60;
const UPLOAD_TIMEOUT_MS = 60000;
const SPEECH_QUALITY = {
  extension: '.m4a',
  sampleRate: 22050,
  numberOfChannels: 1,
  bitRate: 32000,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.LOW },
  web: { mimeType: 'audio/mp4', bitsPerSecond: 32000 }
};
const row = { flexDirection: 'row', alignItems: 'center', gap: 8 };
const round = { minWidth: 46, minHeight: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#94A3B8', paddingHorizontal: 12 };

/** Tap to record, tap to stop, then send or discard. */
export function VoiceNoteRecorder({ conversationId, disabled = false, disabledReason = '', onSent, onError, color = '#0F172A' }) {
  const recorder = useAudioRecorder(SPEECH_QUALITY);
  const [mode, setMode] = useState('idle');
  const [seconds, setSeconds] = useState(0);
  const timer = useRef(null);
  const clip = useRef(null);
  const sending = useRef(false);
  const clear = () => { if (timer.current) clearInterval(timer.current); timer.current = null; };
  const recording = useRef(false);
  const sendKey = useRef(null);
  // Leaving the chat must never leave the microphone on.
  useEffect(() => () => {
    clear();
    if (!recording.current) return;
    recording.current = false;
    Promise.resolve().then(() => recorder.stop()).catch(() => {});
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
  }, []);

  async function start() {
    if (disabled) { onError?.(disabledReason); return; }
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) { onError?.('Allow the microphone in your phone settings to send voice notes.'); return; }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recording.current = true;
      setSeconds(0);
      setMode('recording');
      let elapsed = 0;
      timer.current = setInterval(() => {
        elapsed += 1;
        setSeconds(elapsed);
        if (elapsed >= MAX_SECONDS) stop();
      }, 1000);
    } catch (e) {
      onError?.(e.message || 'Recording could not start.');
    }
  }

  async function stop() {
    if (!recording.current) return;
    recording.current = false;
    clear();
    try {
      await recorder.stop();
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      clip.current = recorder.uri;
      sendKey.current = Crypto.randomUUID(); // Retrying this clip cannot send it twice.
      setMode(clip.current ? 'review' : 'idle');
    } catch (e) {
      setMode('idle');
      onError?.(e.message || 'Recording could not be saved.');
    }
  }

  async function send() {
    if (sending.current) return;
    sending.current = true;
    setMode('sending');
    try {
      const audioBase64 = await readAsStringAsync(clip.current, { encoding: EncodingType.Base64 });
      const message = await call('POST', `/api/v1/chat/conversations/${conversationId}/voice-notes`, {
        clientMessageId: sendKey.current,
        durationSeconds: Math.min(MAX_SECONDS, Math.max(1, seconds)),
        audioBase64
      }, { timeoutMs: UPLOAD_TIMEOUT_MS });
      setMode('idle');
      onSent?.(message);
    } catch (e) {
      setMode('review');
      onError?.(e.message || 'Voice note could not be sent.');
    } finally {
      sending.current = false;
    }
  }

  if (mode === 'sending') return <ActivityIndicator accessibilityLabel="Sending voice note" />;
  if (mode === 'review') return (
    <View style={row}>
      <TouchableOpacity accessibilityRole="button" style={round} onPress={() => setMode('idle')}>
        <Text style={{ color, fontWeight: '700', fontSize: 13 }}>Discard</Text>
      </TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" style={round} onPress={send}>
        <Text style={{ color, fontWeight: '800', fontSize: 13 }}>Send {seconds}s</Text>
      </TouchableOpacity>
    </View>
  );
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={mode === 'recording' ? 'Stop recording' : 'Record a voice note'}
      style={[round, mode === 'recording' && { backgroundColor: '#DC2626', borderColor: '#DC2626' }, disabled && { opacity: 0.45 }]}
      onPress={mode === 'recording' ? stop : start}>
      <Text style={{ color: mode === 'recording' ? '#FFFFFF' : color, fontWeight: '800', fontSize: mode === 'recording' ? 13 : 18 }}>{mode === 'recording' ? `Stop ${seconds}s` : '🎤'}</Text>
    </TouchableOpacity>
  );
}

function LoadedPlayer({ source, label, color }) {
  const player = useAudioPlayer(source);
  const status = useAudioPlayerStatus(player);
  const started = useRef(false);
  useEffect(() => {
    if (status.isLoaded && !started.current) { started.current = true; player.play(); }
  }, [status.isLoaded]);
  const finished = status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration);
  const toggle = async () => {
    if (status.playing) { player.pause(); return; }
    if (finished) await player.seekTo(0);
    player.play();
  };
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={status.playing ? 'Pause voice note' : 'Play voice note'} style={row} onPress={toggle}>
      {status.isLoaded ? <Text style={{ fontSize: 18, color }}>{status.playing ? '⏸' : '▶️'}</Text> : <ActivityIndicator />}
      <Text style={{ fontSize: 13, color, fontWeight: '600' }}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Audio downloads only when tapped, to save the person's data. */
export function VoiceNoteBubble({ message, color = '#0F172A' }) {
  const [source, setSource] = useState(null);
  const voice = message.voiceNote;
  const label = `Voice note, ${voice?.durationSeconds || 0} sec`;
  if (!voice?.available) return <Text style={{ fontSize: 13, color, fontStyle: 'italic' }}>Voice note no longer available</Text>;
  if (source) return <LoadedPlayer source={source} label={label} color={color} />;
  const open = async () => {
    const token = await loadToken();
    setSource({ uri: `${BASE}/api/v1/chat/conversations/${message.conversationId}/messages/${message.id}/audio`, headers: { Authorization: `Bearer ${token}` } });
  };
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Play voice note" style={row} onPress={open}>
      <Text style={{ fontSize: 18, color }}>▶️</Text>
      <Text style={{ fontSize: 13, color, fontWeight: '600' }}>{label}</Text>
    </TouchableOpacity>
  );
}
