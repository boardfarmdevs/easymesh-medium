#!/bin/sh
set -eu

case "$1" in
    list)
        case "$*" in
            *json*)
                # every instance's own config, as `lxc list --format json` gives it
                printf '%s' '[{"name":"bpibroadband","config":{}},{"name":"bpiap","config":{}},'
                printf '%s' '{"name":"bpiap-001","config":{}},'
                printf '%s' '{"name":"wlan-client","config":{"user.easymesh.cohort":"private","user.easymesh.ordinal":"3","user.easymesh.ssid":"private_ssid"}},'
                printf '%s' '{"name":"wlan-client-001","config":{"user.easymesh.cohort":"iot","user.easymesh.ordinal":"2","user.easymesh.ssid":"iot_ssid"}},'
                printf '%s\n' '{"name":"ignored-container","config":{}}]'
                ;;
            *) printf '%s\n' bpibroadband bpiap bpiap-001 wlan-client wlan-client-001 ignored-container ;;
        esac
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
    *) exit 2 ;;
esac
