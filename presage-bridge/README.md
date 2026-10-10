# presage-bridge

Measures pulse, breathing rate and HRV with **Presage SmartSpectra** on this computer's webcam (official
`@smartspectra/node-sdk`) and sends them to the backend. Needed because SmartSpectra runs on-device and has
no browser SDK or cloud measurement API. Native iOS/Android apps can skip this and POST to the backend directly.

```bash
npm install
cp .env.example .env                       # put your PRESAGE_API_KEY in it (https://physiology.presagetech.com)
node bridge.js measure --checkin 12        # real measurement -> POST /api/checkins/12/vitals
node bridge.js measure --patient 3         # -> POST /api/patients/3/vitals
node bridge.js measure --checkin 12 --demo --pulse 104 --breathing 27   # simulated, no camera/key
node bridge.js serve                       # web app triggers: POST http://localhost:8787/measure {"checkin_id": 12}
```

Tips for a good reading: face the camera, steady, good front lighting, chest visible, ~45 s (breathing rate
needs ~30 s before it's stable; HRV ~60 s). The bridge prints Presage's hints ("face not centered", "too dark").

Don't open the camera in the browser at the same time the bridge is measuring.
