(function () {
  if (window.HeyNanoSpeech) return;

  function createSTT(opts = {}) {
    const provider = (opts.provider || 'web-speech').toLowerCase();

    if (provider === 'web-speech') {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) {
        return {
          provider,
          start: () => { throw new Error('Web Speech API (STT) not supported in this browser.'); },
          stop: () => {},
          isActive: () => false,
        };
      }

      let rec = null;
      let active = false;
      let handlers = { onResult: null, onError: null, onStart: null, onStop: null, onState: null };

      function start(h = {}) {
        handlers = { ...handlers, ...h };
        if (active) return;
        rec = new SR();
        rec.lang = opts.lang || 'en-US';
        rec.continuous = opts.continuous !== false; // default true
        rec.interimResults = !!opts.interimResults; // default false

        rec.onresult = (e) => {
          try {
            const transcript = (e.results[e.resultIndex][0].transcript || '').trim();
            if (transcript && typeof handlers.onResult === 'function') handlers.onResult(transcript, e);
          } catch (err) {
            console.warn('STT onresult handler error:', err);
          }
        };

        rec.onerror = (e) => {
          try { if (typeof handlers.onError === 'function') handlers.onError(e); } catch {}
        };

        rec.onend = () => {
          // Auto-restart while active
          if (active) {
            try { rec.start(); } catch (e) {}
          } else {
            try { if (typeof handlers.onStop === 'function') handlers.onStop(); } catch {}
            try { if (typeof handlers.onState === 'function') handlers.onState('stopped'); } catch {}
          }
        };

        active = true;
        try { if (typeof handlers.onStart === 'function') handlers.onStart(); } catch {}
        try { if (typeof handlers.onState === 'function') handlers.onState('listening'); } catch {}
        try { rec.start(); } catch (e) {}
      }

      function stop() {
        if (!active) return;
        active = false;
        if (rec) {
          try { rec.onend = null; } catch {}
          try { rec.stop(); } catch {}
          rec = null;
        }
        try { if (typeof handlers.onStop === 'function') handlers.onStop(); } catch {}
        try { if (typeof handlers.onState === 'function') handlers.onState('stopped'); } catch {}
      }

      return { provider, start, stop, isActive: () => active };
    }

    // Placeholder for future providers (OpenAI Whisper, GPT+, Claude, Gemini via background scripts)
    return {
      provider,
      start: () => { throw new Error(`STT provider '${provider}' not implemented. See README for integration notes.`); },
      stop: () => {},
      isActive: () => false,
    };
  }

  function speak(text, opts = {}) {
    const provider = (opts.provider || 'web-speech').toLowerCase();
    if (provider === 'web-speech') {
      const synth = window.speechSynthesis;
      const Utter = window.SpeechSynthesisUtterance;
      if (!synth || !Utter) throw new Error('Web Speech API (TTS) not supported in this browser.');
      const u = new Utter(String(text || ''));
      if (opts.lang) u.lang = opts.lang;
      if (opts.pitch != null) u.pitch = opts.pitch;
      if (opts.rate != null) u.rate = opts.rate;
      if (opts.volume != null) u.volume = opts.volume;
      if (opts.voiceName && Array.isArray(synth.getVoices)) {
        const v = (synth.getVoices() || []).find(v => v.name === opts.voiceName);
        if (v) u.voice = v;
      }
      synth.speak(u);
      return u;
    }
    throw new Error(`TTS provider '${provider}' not implemented. See README for integration notes.`);
  }

  window.HeyNanoSpeech = {
    // STT
    createSTT,
    // TTS
    tts: { speak },
  };
})();

