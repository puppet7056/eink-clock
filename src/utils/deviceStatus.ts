import { useEffect, useState } from 'react';

interface BatteryManagerLike extends EventTarget {
  readonly charging: boolean;
  readonly level: number;
}

interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManagerLike>;
  connection?: EventTarget & {
    readonly type?: string;
    readonly effectiveType?: string;
  };
}

interface CordovaBatteryEvent extends Event {
  level?: number;
  isPlugged?: boolean;
}

export interface BatteryStatus {
  /** 0 - 100 integer percentage */
  level: number;
  charging: boolean;
}

export interface DeviceStatus {
  battery: BatteryStatus | null;
  isOnline: boolean;
  connectionLabel: string;
}

function getConnectionLabel(isOnline: boolean): string {
  if (!isOnline) return '已離線';
  if (typeof navigator === 'undefined') return '已連線';
  const nav = navigator as NavigatorWithBattery;
  const connType = nav.connection?.type?.toLowerCase();
  if (connType === 'wifi') return 'Wi-Fi 已連線';
  if (connType === 'cellular') return '行動網路已連線';
  if (connType === 'ethernet') return '有線網路已連線';
  return '網路已連線';
}

export function useDeviceStatus(): DeviceStatus {
  const [battery, setBattery] = useState<BatteryStatus | null>(null);
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine !== false : true
  );
  const [connectionLabel, setConnectionLabel] = useState<string>(() =>
    getConnectionLabel(typeof navigator !== 'undefined' ? navigator.onLine !== false : true)
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
    let active = true;
    const nav = navigator as NavigatorWithBattery;

    const syncNetwork = () => {
      const online = navigator.onLine !== false;
      setIsOnline(online);
      setConnectionLabel(getConnectionLabel(online));
    };

    syncNetwork();
    window.addEventListener('online', syncNetwork);
    window.addEventListener('offline', syncNetwork);
    window.addEventListener('eink-cordova-ready', syncNetwork);

    const conn = nav.connection;
    if (conn && typeof conn.addEventListener === 'function') {
      conn.addEventListener('change', syncNetwork);
    }

    // Cordova native battery plugin fallback (if present)
    const handleCordovaBattery = (ev: Event) => {
      const bEv = ev as CordovaBatteryEvent;
      if (typeof bEv.level === 'number' && !Number.isNaN(bEv.level)) {
        setBattery({
          level: Math.max(0, Math.min(100, Math.round(bEv.level))),
          charging: Boolean(bEv.isPlugged),
        });
      }
    };
    window.addEventListener('batterystatus', handleCordovaBattery);

    // Web Battery Status API (supported natively by Android WebView / Chrome / Edge)
    let batteryManager: BatteryManagerLike | null = null;
    const syncBatteryFromManager = () => {
      if (!active || !batteryManager) return;
      const pct = Math.max(0, Math.min(100, Math.round(batteryManager.level * 100)));
      setBattery({
        level: pct,
        charging: Boolean(batteryManager.charging),
      });
    };

    const initBattery = () => {
      if (typeof nav.getBattery !== 'function') return;
      nav
        .getBattery()
        .then((bm) => {
          if (!active) return;
          if (batteryManager) {
            batteryManager.removeEventListener('levelchange', syncBatteryFromManager);
            batteryManager.removeEventListener('chargingchange', syncBatteryFromManager);
          }
          batteryManager = bm;
          syncBatteryFromManager();
          bm.addEventListener('levelchange', syncBatteryFromManager);
          bm.addEventListener('chargingchange', syncBatteryFromManager);
        })
        .catch(() => {
          // Battery API not permitted in this runtime
        });
    };

    initBattery();

    const handleVisibilityOrResume = () => {
      if (document.visibilityState !== 'hidden') {
        syncNetwork();
        if (batteryManager) {
          syncBatteryFromManager();
        } else {
          initBattery();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityOrResume);
    window.addEventListener('eink-cordova-ready', handleVisibilityOrResume);

    return () => {
      active = false;
      window.removeEventListener('online', syncNetwork);
      window.removeEventListener('offline', syncNetwork);
      window.removeEventListener('eink-cordova-ready', syncNetwork);
      window.removeEventListener('eink-cordova-ready', handleVisibilityOrResume);
      window.removeEventListener('batterystatus', handleCordovaBattery);
      document.removeEventListener('visibilitychange', handleVisibilityOrResume);
      if (conn && typeof conn.removeEventListener === 'function') {
        conn.removeEventListener('change', syncNetwork);
      }
      if (batteryManager) {
        batteryManager.removeEventListener('levelchange', syncBatteryFromManager);
        batteryManager.removeEventListener('chargingchange', syncBatteryFromManager);
      }
    };
  }, []);

  return { battery, isOnline, connectionLabel };
}
