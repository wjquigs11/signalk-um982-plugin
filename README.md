# Signal K plugin for interfacing with Unicore UM982 RTK GNSS receivers with NTRIP integration

This plugin allows Signal K to interface with the [Unicore UM982](https://en.unicorecomm.com/products/detail/26) GNSS positioning and heading module. You can use it to configure the device, mainly sentences output. It also includes a webapp for visualising position and heading drift as well as the satellites visible, in use and their signals. Most of the data is available for both the main and the slave antennas.

The plugin also includes NTRIP client functionality that can provide the receiver with RTCM data over the Internet.

Requires Signal K Server >= v2.18.0 for serial port integration.

<img width="1424" height="937" alt="Image" src="https://github.com/user-attachments/assets/0d1c05b5-efea-415f-ae3d-de83a553b56c" />

## Getting Started

- configure the UM982 serial device with 115200 bps
- the serial connection should show up in the plugin configuration - select & save, rtk connection can be left empty

## TODO

- set frequency of different messages 1/10/30/none
- query frequency of different messages
- query rover mode
- checksum checking?
- show firmware revision?
- saveconfig
- reset to factory settings
- NTRIP latlon from data
- work over webusb functionality
- check main ja slave
- GPHPR
- heading offset CONFIG HEADING OFFSET 90 45
