
import { PathValue, Plugin, PluginConstructor, Position, ServerAPI } from '@signalk/server-api';
import { NtripConfig, NtripOptions, NtripOptionsSchema, startRTCM } from './ntrip';

export type Configuration = {
  connection: string;
} & Omit<NtripOptions, 'xyz'> & Position

const pluginFactory: PluginConstructor = function (app: ServerAPI): Plugin {
  const selfContext = 'vessels.' + app.selfId;

  const knownNmeaConnections: string[] = []
  const knownSerialPorts: string[] = []
  const serialPortWriters = new Map<string, (data: any) => void>();
  const nmeaConnectionIds = new Set<string>();
  let rtcmReceived: number | undefined = undefined


  const updatePluginStatus = () => {
    let status = rtcmReceived ? `RTCM data received ${new Date(rtcmReceived).toLocaleTimeString()}` : 'No RTCM data received yet'
    let errorStatus = false

    if (knownSerialPorts.length === 0 && knownNmeaConnections.length === 0) {
      errorStatus = true
      status = 'No serial ports or NMEA0183 connections available'
    }

    if (errorStatus) {
      app.setPluginError(status);
    } else {
      app.setPluginError('');
      app.setPluginStatus(status);
    }
  }

  // Listen for serial ports
  app.onPropertyValues('serialport', (values) => {
    console.log('Serial ports:', values);
    values.forEach((item) => {
      if (!item || !item.value) return;
      const value = item.value as any;
      if (!knownSerialPorts.includes(value.id)) {
        knownSerialPorts.push(value.id);
      }
      const writer = (data: any) => (app as any).emit(value.eventNames.toStdout, data);
      serialPortWriters.set(value.id, writer);
    })
  })

  // Discover NMEA0183 connections early so they're available in schema
  app.onPropertyValues('pipedprovider', (values) => {
    values.forEach((item) => {
      if (!item || !item.value) return;
      const value = item.value as any;
      if (value.type === 'Multiplexed' || value.type === 'NMEA0183') {
        if (!knownNmeaConnections.includes(value.id)) {
          knownNmeaConnections.push(value.id);
          nmeaConnectionIds.add(value.id);
        }
      }
    })
  })

  let onStop = [] as (() => void)[];

  let currentConnection: string | undefined = undefined

  return {
    id: 'tkurki-um982',
    name: 'Unicore UM982 GNSS Receiver',
    description: 'Signal K plugin for Unicore UM982 GNSS receiver',
    schema: () => {
      // Combine all connections into a single list and remove duplicates
      let allConnections = [...new Set([...knownSerialPorts, ...knownNmeaConnections])];

      // Add current value to enum if not present
      if (currentConnection && !allConnections.includes(currentConnection)) {
        allConnections.unshift(currentConnection);
      }

      if (allConnections.length === 0) {
        allConnections.push('No connections available');
      }

      const result: any = {
        properties: {
          connection: {
            type: "string",
            title: "Serial/NMEA Connection",
            description: allConnections.length === 0 || allConnections[0] === 'No connections available'
              ? 'You need to connect a serial port or NMEA0183 data source for a UM982 device first'
              : 'Select the serial port or NMEA0183 connection for the UM982 device',
            enum: allConnections,
            default: allConnections.length > 0 && allConnections[0] !== 'No connections available'
              ? allConnections[0]
              : undefined
          },
          ntripEnabled: {
            type: "boolean",
            title: "NTRIP Enabled",
            default: true
          },
          antennaOrientation: {
            type: "number",
            title: "Antenna Orientation Offset (degrees)",
            description: "Offset angle between antenna orientation and vessel heading. Sent to device on plugin start.",
            default: 0,
            minimum: 0,
            maximum: 359
          },
          headingPath: {
            type: "string",
            title: "Heading Signal K Path",
            description: "The Signal K path to publish heading data to.",
            default: "navigation.RTKheadingTrue"
          },
          ...NtripOptionsSchema.properties,
        },
        required: ["connection"]
      };

      return result
    },
    start: (config_: NtripConfig & { connection: string, ntripEnabled: boolean, antennaOrientation: number, headingPath: string }) => {
      console.log('UM982 plugin start() called with connection:', config_.connection, 'ntripEnabled:', config_.ntripEnabled, 'antennaOrientation:', config_.antennaOrientation, 'headingPath:', config_.headingPath);

      if (!validateConfiguration(config_)) {
        app.setPluginError('Invalid configuration');
        console.log('UM982 plugin: configuration validation failed');
        return;
      }

      currentConnection = config_.connection;
      console.log('UM982 plugin: knownSerialPorts=', knownSerialPorts, 'knownNmeaConnections=', knownNmeaConnections);
      const isSerialPort = knownSerialPorts.includes(config_.connection);
      const isNmeaConnection = nmeaConnectionIds.has(config_.connection);

      app.setPluginError('');
      app.setPluginStatus('Starting');

      // Set up the writer for the selected connection (if it's a serial port)
      let serialWrite = (data: any) => {
        console.log('No writable connection available');
      };

      if (isSerialPort) {
        const writer = serialPortWriters.get(config_.connection);
        if (writer) {
          serialWrite = (data: any) => {
            if (typeof data === 'string') {
              console.log('UM982 serial command:', data);
            }
            writer(data);
          };
          console.log('Serial writer configured for:', config_.connection);
        }
      }

      setTimeout(() => {
        // Only send configuration commands if using serial connection
        if (isSerialPort) {
          //serialWrite('MODE ROVER UAV')
          //serialWrite('MODE')
          //serialWrite('BESTSATA 1')
          //serialWrite('GPHPR 1')
          // serialWrite('CONFIG HEADING LENGTH 138 10')
          serialWrite('GPGSV 20')
          serialWrite('GPGSVH 20')
          serialWrite('CONFIG')

          // Apply stored antenna orientation offset
          const orientation = config_.antennaOrientation || 0;
          if (orientation > 0) {
            const cmd = `CONFIG HEADING OFFSET ${orientation}`;
            console.log('Applying antenna orientation on start:', cmd);
            serialWrite(cmd);
          }
        }

        let closeRTCM: (() => void) | undefined = undefined;

        if (config_.ntripEnabled) {
          closeRTCM = startRTCM({
            options: config_,
            onData: (data: Buffer) => {
              // Only send RTCM data via serial if using serial connection
              if (isSerialPort) {
                serialWrite(data)
              }
              rtcmReceived = Date.now()
            },
            onError: (e) => {
              console.error('RTCM Error', e)
            },
            onClose: () => {
              updatePluginStatus
            },
            onStationData: (delta: any) => app.handleMessage('N/A', delta)
          })
        }

        const updatePluginStatusTimer = setInterval(() => {
          updatePluginStatus()
        }, 1000)
        onStop.push(() => {
          clearInterval(updatePluginStatusTimer);
          if (closeRTCM) {
            closeRTCM();
          }
        });

      }, 1000);
      updatePluginStatus();

      // Set up NMEA data parsing for the selected connection (if using NMEA0183 data source)
      // Always register the listener regardless of current nmeaConnectionIds state,
      // because on fresh server start the pipedprovider values may not have arrived yet.
      const headingPath = config_.headingPath || 'navigation.RTKheadingTrue';

      // Publish metadata so Signal K knows the units for this path
      app.handleMessage('N/A', {
        updates: [{
          meta: [{
            path: headingPath as any,
            value: {
              units: 'rad',
              description: 'True heading from UM982 RTK receiver'
            }
          }]
        }]
      });

      const emitDelta = (delta: any) => {
        // Remap navigation.headingTrue to configured heading path
        if (delta && delta.updates) {
          delta.updates.forEach((update: any) => {
            if (update.values) {
              update.values.forEach((v: any) => {
                if (v.path === 'navigation.headingTrue') {
                  v.path = headingPath;
                }
              });
            }
          });
        }
        app.handleMessage('N/A', delta);
      };

      console.log('UM982 plugin: registering pipedprovider listener for connection:', config_.connection);
      let nmeaListenerAttached = false;
      app.onPropertyValues('pipedprovider', (values) => {
        if (nmeaListenerAttached) return; // only attach once
        console.log('UM982 plugin: pipedprovider values received, count:', values.length);
        values.forEach((item) => {
          if (!item || !item.value) return;
          const value = item.value as any;
          console.log('UM982 plugin: pipedprovider item: id=', value.id, 'type=', value.type, 'match=', value.id === config_.connection);
          if (value.id !== config_.connection) return;
          if (value.type !== 'Multiplexed' && value.type !== 'NMEA0183') return;
          nmeaListenerAttached = true;
          console.log('UM982 plugin: attaching NMEA parser for connection:', value.id, 'type:', value.type, 'eventNames:', JSON.stringify(value.eventNames));
          if (value.type === 'Multiplexed') {
            (app as any).on(value.eventNames.received, (data: any) => {
              parseMultiplexedNmea(data.toString(), emitDelta);
            })
          } else if (value.type === 'NMEA0183') {
            (app as any).on(value.eventNames.received, (data: any) => {
              parseNmeaSentence(data.toString(), emitDelta);
            })
          }
        })
      })

    },
    stop: () => {
      onStop.forEach(f => f());
      onStop = []
    },
    registerWithRouter: (router: any) => {
      // Send a sentence/command to the UM982 device
      router.post('/send/:sentence/:interval?', (req: any, res: any) => {
        const { sentence, interval } = req.params;
        const isSerialPort = currentConnection && knownSerialPorts.includes(currentConnection);

        if (!isSerialPort) {
          res.status(400).json({ error: 'No serial port connection active' });
          return;
        }

        const writer = currentConnection ? serialPortWriters.get(currentConnection) : undefined;
        if (!writer) {
          res.status(500).json({ error: 'No writer available for current connection' });
          return;
        }

        let command: string;
        if (interval !== undefined && interval !== null) {
          command = `${sentence} ${interval}`;
        } else {
          command = sentence;
        }

        console.log('Sending command to UM982:', command);
        writer(command);
        res.status(200).json({ ok: true, command });
      });

      // Set the antenna orientation offset
      router.post('/antenna-orientation/:degrees', (req: any, res: any) => {
        const degrees = parseInt(req.params.degrees, 10);

        if (isNaN(degrees) || degrees < 0 || degrees > 359) {
          res.status(400).json({ error: 'Invalid degrees value. Must be between 0 and 359.' });
          return;
        }

        const isSerialPort = currentConnection && knownSerialPorts.includes(currentConnection);

        if (!isSerialPort) {
          res.status(400).json({ error: 'No serial port connection active' });
          return;
        }

        const writer = currentConnection ? serialPortWriters.get(currentConnection) : undefined;
        if (!writer) {
          res.status(500).json({ error: 'No writer available for current connection' });
          return;
        }

        const command = `CONFIG HEADING OFFSET ${degrees}`;
        console.log('Setting antenna orientation:', command);
        writer(command);

        // Persist the orientation in plugin config
        const options = app.readPluginOptions() as any;
        if (options && options.configuration) {
          options.configuration.antennaOrientation = degrees;
          app.savePluginOptions(options, (err) => {
            if (err) {
              console.error('Failed to save antenna orientation to config:', err);
            } else {
              console.log('Antenna orientation saved to config:', degrees);
            }
          });
        }

        res.status(200).json({ ok: true, command });
      });

      // GET endpoint for current antenna orientation from config
      router.get('/antenna-orientation', (req: any, res: any) => {
        const options = app.readPluginOptions() as any;
        const degrees = options?.configuration?.antennaOrientation || 0;
        res.status(200).json({ degrees });
      });

      // GET endpoint for current heading path from config
      router.get('/heading-path', (req: any, res: any) => {
        const options = app.readPluginOptions() as any;
        const path = options?.configuration?.headingPath || 'navigation.RTKheadingTrue';
        res.status(200).json({ path });
      });

      // POST endpoint to set heading path in config
      router.post('/heading-path', (req: any, res: any) => {
        const { path } = req.body || {};

        if (!path || typeof path !== 'string' || !path.trim()) {
          res.status(400).json({ error: 'Invalid path value' });
          return;
        }

        const options = app.readPluginOptions() as any;
        if (options && options.configuration) {
          options.configuration.headingPath = path.trim();
          app.savePluginOptions(options, (err) => {
            if (err) {
              console.error('Failed to save heading path to config:', err);
              res.status(500).json({ error: 'Failed to save configuration' });
            } else {
              console.log('Heading path saved to config:', path.trim());
              res.status(200).json({ ok: true, path: path.trim() });
            }
          });
        } else {
          res.status(500).json({ error: 'Could not read plugin options' });
        }
      });
    }
  };
};

const parseMultiplexedNmea = (multiplexedLine: string, handleMessage: any) => {
  const [timestamp, discriminator, ...nmeaSentenceData] = multiplexedLine.split(';');
  const sentence = nmeaSentenceData.join(';').trim();
  parseNmeaSentence(sentence, handleMessage);
}

let lastHprDebugLog = 0;
let lastHeadingDeltaLog = 0;

const parseNmeaSentence = (compleSentence: string, handleMessage: any) => {
  // Handle multiplexed format: strip "timestamp;discriminator;" prefix if present
  let sentence = compleSentence;
  const semicolonIndex = sentence.indexOf(';');
  if (semicolonIndex !== -1) {
    // Check if this looks like a multiplexed line (starts with digits followed by semicolons)
    const beforeFirstSemicolon = sentence.substring(0, semicolonIndex);
    if (/^\d+$/.test(beforeFirstSemicolon)) {
      // Strip timestamp and discriminator: "1784823970055;N;$GNHPR,..." -> "$GNHPR,..."
      const afterTimestamp = sentence.substring(semicolonIndex + 1);
      const secondSemicolon = afterTimestamp.indexOf(';');
      if (secondSemicolon !== -1) {
        sentence = afterTimestamp.substring(secondSemicolon + 1).trim();
      }
    }
  }

  const parts = sentence.split(',')
  let parser = (_s: string[], sentence: string) => [] as PathValue[];

  // Handle GSV/GSVH sentences (satellites in view for main/slave antenna)
  const sentenceId = parts[0];
  if (sentenceId && (sentenceId.match(/^\$G[A-Z]GSV$/) || sentenceId.match(/^\$G[A-Z]GSVH$/))) {
    const gsvValues = gsvParser(parts, sentenceId);
    if (gsvValues.length) {
      handleMessage({
        updates: [{
          values: gsvValues
        }]
      });
    }
    return;
  }

  switch (sentenceId) {
    case '#UNIHEADINGA':
      parser = uniheadingAParser
      break
    case '#MODE':
      parser = modeParser
      break
    case '#BESTSATA':
      parser = bestSatParser
      break
    case '$GNHPR':
      parser = hprParser
      break
    case '$CONFIG':
      parser = configParser
      break
    default:
      return;
  }
  // NOTE changed UNIHEADINGA parser to use 2nd param
  const values = parser(parts, sentence.split('*')[0]);

  // Throttled debug logging for HPR parsing (max once per 10 seconds)
  // if (parts[0] === '$GNHPR') {
  //   const now = Date.now();
  //   if (now - lastHprDebugLog >= 10000) {
  //     lastHprDebugLog = now;
  //     if (values.length) {
  //       console.log('HPR parsed successfully:', JSON.stringify(values));
  //     } else {
  //       console.log('HPR parse returned no values from:', sentence);
  //     }
  //   }
  // }

  if (values.length) {
    // Throttled debug logging for heading delta emission (max once per 10 seconds)
    // const headingValue = values.find((v: PathValue) => v.path === 'navigation.headingTrue');
    // if (headingValue) {
    //   const now = Date.now();
    //   if (now - lastHeadingDeltaLog >= 10000) {
    //     lastHeadingDeltaLog = now;
    //     console.log('Sending navigation.headingTrue to SignalK:', JSON.stringify(headingValue), 'from sentence type:', parts[0]);
    //   }
    // }

    handleMessage({
      updates: [{
        values
      }]
    });
  }
}
/*
MODE ROVER

> GNRMC 1
$command,GNRMC 1,response: OK*1A

// configuration of UM-982:
// unlog: stop all logging on current port
// gphpr com1 1: Heading Pitch Roll on com1 every second
// config: show configuration
// saveconfig
// uniloglist
// freset: factory reset
// gpgga com1 1
// mode heading2 lowdynamic



*/

const configMap: { [key: string]: string } = {}
const configParser = (parts: string[]) => {
  configMap[parts[1]] = parts[2].slice(0, -4).split(' ').slice(2).join(' ');
  console.log('UM982 CONFIG response:', parts[1], '=', configMap[parts[1]]);
  return [{
    path: 'sensors.rtk.um982',
    value: configMap
  }] as PathValue[];
}

// GSV sentence system prefix to GNSS system name mapping
const gsvSystemMap: { [key: string]: string } = {
  'GP': 'GPS',
  'GL': 'GLONASS',
  'GB': 'BeiDou',
  'GA': 'Galileo',
  'GQ': 'QZSS',
  'GN': 'GPS', // multi-system fallback
  'GI': 'NavIC'
};

const gsvParser = (parts: string[], sentenceId: string): PathValue[] => {
  // Determine antenna type: GSVH = slave, GSV = main
  const isSlaveAntenna = sentenceId.endsWith('GSVH');

  // Extract system prefix (e.g. $GPGSV -> GP, $GLGSVH -> GL)
  const prefix = sentenceId.substring(1, 3);
  const gnssSystem = gsvSystemMap[prefix] || 'Unknown';
  const antennaType = isSlaveAntenna ? 'SLAVE' : 'MAIN';

  // GSV format: $xxGSV,totalMsgs,msgNum,totalSats,[satId,elev,azim,snr],...,signalId*checksum
  // Each satellite block is 4 fields: id, elevation(deg), azimuth(deg), SNR(dB)
  // The last field before the checksum may be a signal ID (NMEA 4.10+)

  const satellites: { id: string, elevation: number | null, azimuth: number | null, SNR: number | null }[] = [];

  // Satellite data starts at index 4, in groups of 4
  // Remove checksum from last field if present
  const cleanParts = [...parts];
  const lastIdx = cleanParts.length - 1;
  if (cleanParts[lastIdx] && cleanParts[lastIdx].includes('*')) {
    cleanParts[lastIdx] = cleanParts[lastIdx].split('*')[0];
  }

  // Determine how many satellite blocks we have
  // Fields 4,5,6,7 = sat1; 8,9,10,11 = sat2; etc.
  // But there may be a trailing signal ID field (single digit) at the end
  let dataFields = cleanParts.slice(4);

  // Check if last field is a signal ID (1-2 digit number that doesn't fit in a group of 4)
  if (dataFields.length % 4 === 1) {
    dataFields = dataFields.slice(0, -1); // remove signal ID
  }

  for (let i = 0; i + 3 < dataFields.length; i += 4) {
    const satId = dataFields[i];
    const elev = dataFields[i + 1];
    const azim = dataFields[i + 2];
    const snr = dataFields[i + 3];

    if (!satId) continue;

    satellites.push({
      id: satId,
      elevation: elev ? parseFloat(elev) * Math.PI / 180 : null,  // convert to radians
      azimuth: azim ? parseFloat(azim) * Math.PI / 180 : null,    // convert to radians
      SNR: snr ? parseFloat(snr) : null
    });
  }

  if (satellites.length === 0) return [];

  return [{
    path: 'navigation.gnss.satellitesInView',
    value: {
      gnss: gnssSystem,
      antennaType: antennaType,
      satellites: satellites
    }
  }] as PathValue[];
};

const modeParser = (parts: string[]) => [{
  path: 'navigation.gnss.9820.mode',
  value: parts.slice(1).join(',')
} as PathValue];

const hprParser = (parts: string[]) => {
  const heading = parseFloat(parts[2]);
  return [{
    path: 'navigation.headingTrue',
    value: heading === 0 ? null : heading * Math.PI / 180
  }
  ] as PathValue[]
}

// Decode BESTSATA signal mask field
const decodeBestSatMask = (maskHex: string, gnssSystem: string) => {
  const mask = parseInt(maskHex, 16);
  const signals: string[] = [];

  // Signal bit definitions vary by GNSS system
  switch (gnssSystem) {
    case 'GPS':
      if (mask & 0x01) signals.push('L1CA');
      if (mask & 0x02) signals.push('L1P');
      if (mask & 0x04) signals.push('L1M');
      if (mask & 0x08) signals.push('L2P');
      if (mask & 0x10) signals.push('L2M');
      if (mask & 0x20) signals.push('L5I');
      if (mask & 0x40) signals.push('L5Q');
      if (mask & 0x80) signals.push('L1C');
      break;

    case 'GLONASS':
      if (mask & 0x01) signals.push('L1CA');
      if (mask & 0x02) signals.push('L1P');
      if (mask & 0x04) signals.push('L2CA');
      if (mask & 0x08) signals.push('L2P');
      if (mask & 0x10) signals.push('L3I');
      if (mask & 0x20) signals.push('L3Q');
      break;

    case 'GALILEO':
      if (mask & 0x01) signals.push('E1B');
      if (mask & 0x02) signals.push('E1C');
      if (mask & 0x04) signals.push('E5aI');
      if (mask & 0x08) signals.push('E5aQ');
      if (mask & 0x10) signals.push('E5bI');
      if (mask & 0x20) signals.push('E5bQ');
      if (mask & 0x40) signals.push('E6B');
      if (mask & 0x80) signals.push('E6C');
      break;

    case 'BEIDOU':
      if (mask & 0x01) signals.push('B1I');
      if (mask & 0x02) signals.push('B1Q');
      if (mask & 0x04) signals.push('B2I');
      if (mask & 0x08) signals.push('B2Q');
      if (mask & 0x10) signals.push('B3I');
      if (mask & 0x20) signals.push('B3Q');
      break;

    case 'QZSS':
      if (mask & 0x01) signals.push('L1CA');
      if (mask & 0x02) signals.push('L1C');
      if (mask & 0x04) signals.push('L2C');
      if (mask & 0x08) signals.push('L5I');
      if (mask & 0x10) signals.push('L5Q');
      break;

    default:
      // For unknown systems, just return the hex value
      signals.push(`0x${maskHex}`);
  }

  return signals;
};

const bestSatParser = (parts: string[], sentence: string) => {
  // BESTSATA message format:
  // #BESTSATA,90,GPS,FINE,2389,362704000,0,0,18,24;18,GPS,1,GOOD,00000017,GPS,2,GOOD,00000011...
  // After preamble (first 10 parts including the semicolon split), entries have 4 fields:
  // satellite ID, GNSS system, status (ignored), signal mask

  if (parts.length < 10) {
    return [];
  }
  const [preamble, data] = sentence.split(';');

  const satellites: { gnss: string, id: string, mask: string, signals: string[] }[] = [];

  const satelliteData = data.split(',');
  for (let i = 0; i < Number(satelliteData[0]); i++) {
    const gnssSystem = satelliteData[i * 4 + 1];
    const satId = satelliteData[i * 4 + 2];
    const maskHex = satelliteData[i * 4 + 4];
    const signals = decodeBestSatMask(maskHex, gnssSystem);

    satellites.push({
      gnss: gnssSystem,
      id: satId,
      mask: maskHex,
      signals: signals
    });
  }

  return [{
    path: 'navigation.gnss.satellitesUsed',
    value: {
      satellites: satellites
    }
  } as PathValue];
};

const CONVERTERS = {
  UNIHEADINGA: [
    { index: 2, path: 'sensors.rtk.solutionStatus', convert: (v: string) => v },
    { index: 3, path: 'sensors.rtk.positionType', convert: (v: string) => v },
    { index: 4, path: 'sensors.rtk.baselineLength', convert: (v: string) => parseFloat(v) },
    {
      index: 5, path: 'navigation.headingTrue', convert: (v: string) => {
        if (v < '0.0') return null;
        return parseFloat(v) * Math.PI / 180
      }
    },
    { index: 6, path: 'navigation.attitude.pitch', convert: (v: string) => parseFloat(v) * Math.PI / 180 },
    // 8 == heading std dev in docs
    { index: 8, path: 'navigation.position.HDGstddev', convert: (v: string) => parseFloat(v) },
    // 9 == pitch std dev in docs
    { index: 9, path: 'navigation.position.PITCHstddev', convert: (v: string) => parseFloat(v) },
    { index: 11, path: 'navigation.satellites.inView', convert: (v: string) => parseInt(v, 10) },
    { index: 12, path: 'navigation.satellites.used', convert: (v: string) => parseInt(v, 10) },
    // 16 == extended solution status (7-88) verification, ionospheric correction
    // 17 == GAL and BDS bitmask
    // 18 = GPS, GLON, BSD2 bitmask
    // leaving as string for now since these are bitmaps
    { index: 17, path: 'navigation.satellites.GAL-BDS', convert: (v: string) => v },
    { index: 18, path: 'navigation.satellites.GPS-GLON', convert: (v: string) => v }
  ]
}
const POSITION_TYPE_INDEX = CONVERTERS.UNIHEADINGA.findIndex(c => c.path === 'sensors.rtk.positionType');
const HEADING_TRUE_INDEX = CONVERTERS.UNIHEADINGA.findIndex(c => c.path === 'navigation.headingTrue');

// modified UNIHEADINGA parser to extract entire message header
// (i.e. everything up to first semicolon)
// which lets field indexes match UM982 documentation
const uniheadingAParser = (parts: string[], sentence: string) => {
  // console.log('UNIHEADINGA received:', sentence);

  // Split by semicolon first to separate header from data
  const [headerSection, dataSection] = sentence.split(';');

  if (!dataSection) {
    console.log('No data section found after semicolon');
    return [];
  }

  // Parse data section by commas (remove checksum if present)
  const dataFields = dataSection.split('*')[0].split(',');

  // console.log('UNIHEADINGA data fields:', dataFields);

  // subtracting 2 from index->datafield mapping to be consistent with UM982 documentation for UNIHEADINGA
  // field ID 1 is header
  // field ID 2 is sol stat...
  const parsed = CONVERTERS.UNIHEADINGA.map(c => ({
    path: c.path,
    value: c.convert(dataFields[c.index - 2] || 'invalid')
  } as PathValue))

  // console.log('UNIHEADINGA parsed values:', parsed);

  if (parsed[POSITION_TYPE_INDEX].value === 'NONE') {
    // console.log('Position type is NONE, setting heading to null');
    parsed[HEADING_TRUE_INDEX].value = null;
  }

  return parsed;
}


//OBSVM


const sample = [
  '93', //0
  'GPS', //1
  'FINE', //2
  '2385', //3
  '326592000', //4
  '0', //5
  '0', //6
  '18', //7
  '10;SOL_COMPUTED', //8
  'NARROW_FLOAT', //9
  '5.4970', //10. Baseline length
  '219.2125', //11 Heading deg
  '24.6176', //12 pitch
  '0.0000', //13
  '15.8976', //14
  '34.8232', //15
  '"999"', //16
  '21', //17
  '9', //18
  '9', //19
  '5', //20
  '3', //21
  '00', //22
  '3', // 23
  '13' //24
]

function validateConfiguration(obj: any): obj is Configuration {
  if (!obj || typeof obj !== 'object') {
    console.log('UM982 validation failed: obj is null or not an object');
    return false;
  }

  console.log('UM982 validateConfiguration called with:', JSON.stringify(obj, null, 2));

  // Validate connection is provided
  if (!obj.connection ||
    typeof obj.connection !== 'string' ||
    obj.connection.trim() === '' ||
    obj.connection === 'No connections available') {
    console.log('UM982 validation failed: connection invalid, value:', obj.connection);
    return false;
  }

  // Only validate NTRIP configuration if NTRIP is enabled
  if (obj.ntripEnabled === true) {
    // Check required string properties for NTRIP (password is optional)
    if (
      typeof obj.host !== 'string' ||
      typeof obj.mountpoint !== 'string' ||
      typeof obj.username !== 'string') {
      console.log('UM982 validation failed: NTRIP string fields - host:', typeof obj.host, 'mountpoint:', typeof obj.mountpoint, 'username:', typeof obj.username);
      return false;
    }

    // Check required number properties for NTRIP
    if (typeof obj.port !== 'number' ||
      typeof obj.interval !== 'number' ||
      typeof obj.latitude !== 'number' ||
      typeof obj.longitude !== 'number') {
      console.log('UM982 validation failed: NTRIP number fields - port:', typeof obj.port, obj.port, 'interval:', typeof obj.interval, obj.interval, 'latitude:', typeof obj.latitude, obj.latitude, 'longitude:', typeof obj.longitude, obj.longitude);
      return false;
    }

    // Check that numbers are valid for NTRIP
    if (!Number.isFinite(obj.port) || obj.port <= 0 ||
      !Number.isFinite(obj.interval) || obj.interval <= 0 ||
      !Number.isFinite(obj.latitude) ||
      !Number.isFinite(obj.longitude)) {
      console.log('UM982 validation failed: NTRIP number range checks - port:', obj.port, 'interval:', obj.interval, 'latitude:', obj.latitude, 'longitude:', obj.longitude);
      return false;
    }

    // Check latitude/longitude ranges for NTRIP
    if (obj.latitude < -90 || obj.latitude > 90 ||
      obj.longitude < -180 || obj.longitude > 180) {
      console.log('UM982 validation failed: lat/lon out of range - latitude:', obj.latitude, 'longitude:', obj.longitude);
      return false;
    }
  }

  console.log('UM982 validation passed');
  return true;
}

export default pluginFactory;
