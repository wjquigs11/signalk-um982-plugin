
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
    values.filter(v => v).forEach(({ value }) => {
      if (!knownSerialPorts.includes(value.id)) {
        knownSerialPorts.push(value.id);
      }
      const writer = (data: any) => (app as any).emit(value.eventNames.toStdout, data);
      serialPortWriters.set(value.id, writer);
    })
  })

  // Discover NMEA0183 connections early so they're available in schema
  app.onPropertyValues('pipedprovider', (values) => {
    values.filter(v => v).forEach(({ value }) => {
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
      // Combine all connections into a single list
      const allConnections = [...knownSerialPorts, ...knownNmeaConnections];

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
            default: undefined as string | undefined
          },
          ntripEnabled: {
            type: "boolean",
            title: "NTRIP Enabled",
            default: true
          },
          ...NtripOptionsSchema.properties,
        },
        required: ["connection"]
      };

      // Add current value to enum if not present
      if (currentConnection && !allConnections.includes(currentConnection)) {
        allConnections.unshift(currentConnection);
      }
      if (allConnections.length > 0 && allConnections[0] !== 'No connections available') {
        result.properties.connection.default = allConnections[0];
      }

      return result
    },
    start: (config_: NtripConfig & { connection: string, ntripEnabled: boolean }) => {
      if (!validateConfiguration(config_)) {
        app.setPluginError('Invalid configuration');
        return;
      }

      currentConnection = config_.connection;
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
          serialWrite = writer;
          console.log('Serial writer configured for:', config_.connection);
        }
      }

      setTimeout(() => {
        // Only send configuration commands if using serial connection
        if (isSerialPort) {
          serialWrite('MODE ROVER UAV')
          serialWrite('MODE')
          serialWrite('GPGSVH 1')
          serialWrite('BESTSATA 1')
          serialWrite('GPHPR 1')
          // serialWrite('CONFIG HEADING LENGTH 138 10')
          serialWrite('CONFIG')
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
      if (isNmeaConnection) {
        app.onPropertyValues('pipedprovider', (values) => {
          values.filter(v => v && v.value.id === config_.connection).forEach(({ value }) => {
            console.log('Setting up NMEA parsing for connection:', value.id)
            if (value.type === 'Multiplexed') {
              (app as any).on(value.eventNames.received, (data: any) => {
                parseMultiplexedNmea(data.toString(), (delta: any) => app.handleMessage('N/A', delta));
              })
            } else if (value.type === 'NMEA0183') {
              (app as any).on(value.eventNames.received, (data: any) => {
                parseNmeaSentence(data.toString(), (delta: any) => app.handleMessage('N/A', delta));
              })
            }
          })
        })
      }

    },
    stop: () => {
      onStop.forEach(f => f());
      onStop = []
    }
  };
};

const parseMultiplexedNmea = (multiplexedLine: string, handleMessage: any) => {
  const [timestamp, discriminator, ...nmeaSentenceData] = multiplexedLine.split(';');
  const sentence = nmeaSentenceData.join(';').trim();
  parseNmeaSentence(sentence, handleMessage);
}

const parseNmeaSentence = (compleSentence: string, handleMessage: any) => {
  const parts = compleSentence.split(',')
  let parser = (_s: string[], sentence: string) => [] as PathValue[];
  switch (parts[0]) {
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
  const values = parser(parts, compleSentence.split('*')[0]);
  if (values.length) {
    // console.log(sentence)
    // console.log(values)   
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
  return [{
    path: 'sensors.rtk.um982',
    value: configMap
  }] as PathValue[];
}

const modeParser = (parts: string[]) => [{
  path: 'navigation.gnss.9820.mode',
  value: parts.slice(1).join(',')
} as PathValue];

const hprParser = (parts: string[]) => {
  return [{
    path: 'navigation.headingTrue',
    value: parseFloat(parts[2]) * Math.PI / 180
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
  console.log('UNIHEADINGA received:', sentence);

  // Split by semicolon first to separate header from data
  const [headerSection, dataSection] = sentence.split(';');

  if (!dataSection) {
    console.log('No data section found after semicolon');
    return [];
  }

  // Parse data section by commas (remove checksum if present)
  const dataFields = dataSection.split('*')[0].split(',');

  console.log('UNIHEADINGA data fields:', dataFields);

  // subtracting 2 from index->datafield mapping to be consistent with UM982 documentation for UNIHEADINGA
  // field ID 1 is header
  // field ID 2 is sol stat...
  const parsed = CONVERTERS.UNIHEADINGA.map(c => ({
    path: c.path,
    value: c.convert(dataFields[c.index - 2] || 'invalid')
  } as PathValue))

  console.log('UNIHEADINGA parsed values:', parsed);

  if (parsed[POSITION_TYPE_INDEX].value === 'NONE') {
    console.log('Position type is NONE, setting heading to null');
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
    return false;
  }

  // Validate connection is provided
  if (!obj.connection ||
    typeof obj.connection !== 'string' ||
    obj.connection.trim() === '' ||
    obj.connection === 'No connections available') {
    return false;
  }

  // Only validate NTRIP configuration if NTRIP is enabled
  if (obj.ntripEnabled === true) {
    // Check required string properties for NTRIP
    if (
      typeof obj.host !== 'string' ||
      typeof obj.mountpoint !== 'string' ||
      typeof obj.username !== 'string' ||
      typeof obj.password !== 'string') {
      return false;
    }

    // Check required number properties for NTRIP
    if (typeof obj.port !== 'number' ||
      typeof obj.interval !== 'number' ||
      typeof obj.latitude !== 'number' ||
      typeof obj.longitude !== 'number') {
      return false;
    }

    // Check that numbers are valid for NTRIP
    if (!Number.isFinite(obj.port) || obj.port <= 0 ||
      !Number.isFinite(obj.interval) || obj.interval <= 0 ||
      !Number.isFinite(obj.latitude) ||
      !Number.isFinite(obj.longitude)) {
      return false;
    }

    // Check latitude/longitude ranges for NTRIP
    if (obj.latitude < -90 || obj.latitude > 90 ||
      obj.longitude < -180 || obj.longitude > 180) {
      return false;
    }
  }

  return true;
}

export default pluginFactory;
