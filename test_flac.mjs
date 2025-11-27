import * as flac from 'flac-bindings';
console.log('Import successful');
console.log('Keys:', Object.keys(flac));
if (flac.default) {
    console.log('Default export keys:', Object.keys(flac.default));
}
try {
    new flac.StreamEncoder({ sampleRate: 48000, channels: 1, bitsPerSample: 16 });
    console.log('StreamEncoder (named) works');
} catch (e) {
    console.log('StreamEncoder (named) failed:', e.message);
}

if (flac.default && flac.default.StreamEncoder) {
    try {
        new flac.default.StreamEncoder({ sampleRate: 48000, channels: 1, bitsPerSample: 16 });
        console.log('StreamEncoder (default) works');
    } catch (e) {
        console.log('StreamEncoder (default) failed:', e.message);
    }
}
