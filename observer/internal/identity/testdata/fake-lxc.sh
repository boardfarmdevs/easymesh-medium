#!/bin/sh
set -eu

case "$1" in
    list)
        printf '%s\n' bpibroadband bpiap bpiap-001 wlan-client wlan-client-001 ignored-container
        ;;
    exec)
        case "$2" in
            bpibroadband) echo 02:00:00:00:01:00 ;;
            bpiap) echo 02:00:00:00:02:00 ;;
            bpiap-001) echo 02:00:00:00:03:00 ;;
            wlan-client) echo 02:00:00:00:04:00 ;;
            wlan-client-001) echo 02:00:00:00:05:00 ;;
            *) exit 1 ;;
        esac
        ;;
    config)
        container=$3
        key=$4
        case "$container:$key" in
            wlan-client:user.easymesh.cohort) echo private ;;
            wlan-client:user.easymesh.ordinal) echo 3 ;;
            wlan-client:user.easymesh.ssid) echo private_ssid ;;
            wlan-client-001:user.easymesh.cohort) echo iot ;;
            wlan-client-001:user.easymesh.ordinal) echo 2 ;;
            wlan-client-001:user.easymesh.ssid) echo iot_ssid ;;
        esac
        ;;
    *) exit 2 ;;
esac
