/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Atom, ShieldCheck, Sun, Moon, Sparkles, SlidersHorizontal, 
  MapPin, Keyboard, MonitorPlay, KeyRound, Search, FileDown, 
  CornerRightDown, Loader2, RefreshCw, Star, Info, HelpCircle, X,
  Maximize, Minimize, Globe
} from 'lucide-react';
import { Station } from './types';
import { INITIAL_STATIONS } from './initialData';
import { DetailsModal } from './components/DetailsModal';
import { AdminPanel } from './components/AdminPanel';
import { SleepOverlay } from './components/SleepOverlay';
import { OfflineMap } from './components/OfflineMap';
import { db, isFirebaseEnabled, handleFirestoreError, OperationType } from './firebase';
import { collection, onSnapshot, doc, setDoc, deleteDoc } from 'firebase/firestore';

export default function App() {
  const [stations, setStations] = useState<Station[]>([]);
  const [selectedStation, setSelectedStation] = useState<Station | null>(null);
  const [activeDetails, setActiveDetails] = useState<Station | null>(null);
  
  // Yandex Maps script states & Offline detection
  const [isMapOffline, setIsMapOffline] = useState(false);
  const [mapLibraryLoaded, setMapLibraryLoaded] = useState(false);

  // Map Provider Selector State: 'leaflet' (Default: real OSM map) | 'yandex' (Requires key) | 'offline' (Vector fallback)
  const [mapProvider, setMapProvider] = useState<'leaflet' | 'yandex' | 'offline'>(() => {
    const saved = localStorage.getItem('preferred_map_provider');
    return (saved as any) || 'leaflet';
  });
  
  // Admin & UI panel states
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [theme, setTheme] = useState<'rosatom' | 'tpu'>('rosatom');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<'all' | 'rosatom' | 'tpu' | 'joint'>('all');

  // Sleep scheduling state
  const [sleepStart, setSleepStart] = useState('22:00');
  const [sleepEnd, setSleepEnd] = useState('06:00');
  const [isPowerSavingMode, setIsPowerSavingMode] = useState(false);
  const [sleepBypassed, setSleepBypassed] = useState(false);

  // Yandex Maps refs
  const mapRef = useRef<any>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const geoObjectsGroupRef = useRef<any>(null);
  const placemarksRef = useRef<Record<string, any>>({});

  // Leaflet Map Refs
  const leafletContainerRef = useRef<HTMLDivElement>(null);
  const leafletMapRef = useRef<any>(null);
  const leafletMarkersRef = useRef<any[]>([]);

  // Loading indicator for Firebase remote sync
  const [isSyncing, setIsSyncing] = useState(false);

  // Fullscreen toggle state & handler
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        const elem = document.documentElement;
        if (elem.requestFullscreen) {
          await elem.requestFullscreen();
        } else if ((elem as any).webkitRequestFullscreen) {
          await (elem as any).webkitRequestFullscreen();
        } else if ((elem as any).msRequestFullscreen) {
          await (elem as any).msRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any).webkitExitFullscreen) {
          await (document as any).webkitExitFullscreen();
        } else if ((document as any).msExitFullscreen) {
          await (document as any).msExitFullscreen();
        }
      }
    } catch (err) {
      console.warn("Fullscreen error or not allowed:", err);
    }
  };

  // 0. Progressive Yandex Maps custom dynamic script loader hook with offline timeout fallback
  useEffect(() => {
    // Check if ymaps is already loaded globally
    if ((window as any).ymaps) {
      setMapLibraryLoaded(true);
      return;
    }

    // Check if script tag is already in the document to prevent duplicate loading
    let script = document.querySelector('script[src*="api-maps.yandex.ru"]') as HTMLScriptElement;
    let isNewlyCreated = false;

    if (!script) {
      script = document.createElement('script');
      const apiKey = (import.meta as any).env?.VITE_YANDEX_MAPS_API_KEY || '09b6bd2c-94e2-4ad3-9935-858f6f817b09';
      script.src = apiKey 
        ? `https://api-maps.yandex.ru/2.1/?apikey=${apiKey}&lang=ru_RU`
        : 'https://api-maps.yandex.ru/2.1/?lang=ru_RU';
      script.type = 'text/javascript';
      script.async = true;
      isNewlyCreated = true;
    }

    // Timeout fallback: if script/ymaps doesn't respond within 2.5 seconds, trigger offline mode
    const timeout = setTimeout(() => {
      console.warn('Yandex Maps loading timed out. Switching to offline blueprint map.');
      setIsMapOffline(true);
    }, 2500);

    const handleLoad = () => {
      clearTimeout(timeout);
      const ymaps = (window as any).ymaps;
      if (ymaps) {
        setMapLibraryLoaded(true);
        setIsMapOffline(false);
      } else {
        setIsMapOffline(true);
      }
    };

    const handleError = () => {
      clearTimeout(timeout);
      console.warn('Failed to load Yandex Maps script. Switching to offline blueprint map.');
      setIsMapOffline(true);
    };

    script.addEventListener('load', handleLoad);
    script.addEventListener('error', handleError);

    if (isNewlyCreated) {
      document.head.appendChild(script);
    } else {
      // If it exists but loaded already
      if ((window as any).ymaps) {
        handleLoad();
      }
    }

    return () => {
      clearTimeout(timeout);
      if (script) {
        script.removeEventListener('load', handleLoad);
        script.removeEventListener('error', handleError);
      }
    };
  }, []);

  // 1. Initial State Loading & Storage Fallback
  useEffect(() => {
    // Attempt local storage load
    const saved = localStorage.getItem('tpu_rosatom_stations');
    if (saved) {
      try {
        setStations(JSON.parse(saved));
      } catch (err) {
        console.error('Ошибка загрузки данных из кэша: ', err);
        setStations(INITIAL_STATIONS);
      }
    } else {
      setStations(INITIAL_STATIONS);
      localStorage.setItem('tpu_rosatom_stations', JSON.stringify(INITIAL_STATIONS));
    }

    // Load custom sleep configurations if saved
    const savedStart = localStorage.getItem('kiosk_sleep_start');
    const savedEnd = localStorage.getItem('kiosk_sleep_end');
    if (savedStart) setSleepStart(savedStart);
    if (savedEnd) setSleepEnd(savedEnd);
  }, []);

  // Set up global callback for Yandex Maps Balloon buttons to trigger DetailsModal
  useEffect(() => {
    (window as any).openStationDetails = (id: string) => {
      const found = stations.find(s => s.id === id);
      if (found) {
        setActiveDetails(found);
      }
    };
    return () => {
      delete (window as any).openStationDetails;
    };
  }, [stations]);

  // Write changes back to localStorage cache to guarantee USB portability state
  const updateLocalStationsCache = (newStations: Station[]) => {
    setStations(newStations);
    localStorage.setItem('tpu_rosatom_stations', JSON.stringify(newStations));
  };

  // 2. Real-time Cloud updates (Firestore synchronization)
  useEffect(() => {
    if (!isFirebaseEnabled || !db) return;

    setIsSyncing(true);
    const colRef = collection(db, 'stations');
    
    // Listen for changes from Firestore
    const unsubscribe = onSnapshot(colRef, (snapshot) => {
      const items: Station[] = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        if (data && data.name) {
          items.push({
            id: docSnap.id,
            name: data.name,
            lat: Number(data.lat),
            lon: Number(data.lon),
            shortInfo: data.shortInfo || '',
            fullInfo: data.fullInfo || '',
            type: data.type || 'joint',
            city: data.city || '',
            createdAt: Number(data.createdAt || Date.now())
          });
        }
      });

      if (items.length > 0) {
        // Sync local cache and state with cloud records
        updateLocalStationsCache(items);
        console.log(`Cloud sync active: Loaded ${items.length} stations from Firestore.`);
      }
      setIsSyncing(false);
    }, (error) => {
      console.error("Firestore loading error:", error);
      setIsSyncing(false);
    });

    return () => unsubscribe();
  }, []);

  // 3. Admin Adding / Deleting State Modifiers
  const handleAddStation = async (fields: Omit<Station, 'id' | 'createdAt'>) => {
    const newId = `station-${Date.now()}`;
    const newObj: Station = {
      ...fields,
      id: newId,
      createdAt: Date.now()
    };

    const nextList = [newObj, ...stations];
    updateLocalStationsCache(nextList);

    // If Firestore is working, sync it immediately
    if (isFirebaseEnabled && db) {
      try {
        setIsSyncing(true);
        await setDoc(doc(db, 'stations', newId), {
          ...fields,
          createdAt: Date.now()
        });
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `stations/${newId}`);
      } finally {
        setIsSyncing(false);
      }
    }
  };

  const handleDeleteStation = async (id: string) => {
    const nextList = stations.filter(s => s.id !== id);
    updateLocalStationsCache(nextList);
    
    if (selectedStation?.id === id) {
      setSelectedStation(null);
    }
    if (activeDetails?.id === id) {
      setActiveDetails(null);
    }

    if (isFirebaseEnabled && db) {
      try {
        setIsSyncing(true);
        await deleteDoc(doc(db, 'stations', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `stations/${id}`);
      } finally {
        setIsSyncing(false);
      }
    }
  };

  const handleImportStations = async (imported: Partial<Station>[]) => {
    const verified: Station[] = imported.map((s, idx) => ({
      id: s.id || `imported-${Date.now()}-${idx}`,
      name: s.name || 'Рассеянный узел',
      lat: Number(s.lat || 0),
      lon: Number(s.lon || 0),
      shortInfo: s.shortInfo || '',
      fullInfo: s.fullInfo || '',
      type: s.type || 'joint',
      city: s.city || '',
      createdAt: Number(s.createdAt || Date.now())
    }));

    // Merge or overwrite strategy: add them in front
    const merged = [...verified, ...stations.filter(s => !verified.some(v => v.id === s.id))];
    updateLocalStationsCache(merged);

    // Sync imported records to cloud
    if (isFirebaseEnabled && db) {
      try {
        setIsSyncing(true);
        for (const s of verified) {
          await setDoc(doc(db, 'stations', s.id), {
            name: s.name,
            lat: s.lat,
            lon: s.lon,
            shortInfo: s.shortInfo,
            fullInfo: s.fullInfo,
            type: s.type,
            city: s.city,
            createdAt: s.createdAt
          });
        }
      } catch (err) {
        console.error('Ошибка синхронизации импорта:', err);
      } finally {
        setIsSyncing(false);
      }
    }
  };

  const handleManualSyncWithCloud = async () => {
    if (!isFirebaseEnabled || !db) return;
    setIsSyncing(true);
    try {
      // Sync all local stations that may have been created offline to cloud
      for (const s of stations) {
        await setDoc(doc(db, 'stations', s.id), {
          name: s.name,
          lat: s.lat,
          lon: s.lon,
          shortInfo: s.shortInfo,
          fullInfo: s.fullInfo,
          type: s.type,
          city: s.city,
          createdAt: s.createdAt
        });
      }
      alert('Данные локального кэша успешно объединены и выгружены в облако!');
    } catch (err) {
      alert('Ошибка при синхронизации: ' + String(err));
    } finally {
      setIsSyncing(false);
    }
  };

  const handleChangeSleepHours = (start: string, end: string) => {
    setSleepStart(start);
    setSleepEnd(end);
    localStorage.setItem('kiosk_sleep_start', start);
    localStorage.setItem('kiosk_sleep_end', end);
  };

  // 4. Keyboard Shortcuts: Ctrl+Alt+A to enter/exit admin dashboard
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (e.ctrlKey && e.altKey && (key === 'a' || key === 'ф' || e.code === 'KeyA')) {
        e.preventDefault();
        setIsAdminOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 5. Scheduled Screen Blackout Manager (22:00 - 06:00 checking ticks)
  useEffect(() => {
    const checkScheduledSleep = () => {
      if (sleepBypassed) return; // Administrator bypassed sleep manually

      const now = new Date();
      const currentHours = now.getHours();
      const currentMinutes = now.getMinutes();
      const currentVal = currentHours * 60 + currentMinutes;

      // Parse hours e.g. "22:00" -> 1320 mins
      const [startH, startM] = sleepStart.split(':').map(Number);
      const [endH, endM] = sleepEnd.split(':').map(Number);
      
      const startMins = (isNaN(startH) ? 22 : startH) * 60 + (isNaN(startM) ? 0 : startM);
      const endMins = (isNaN(endH) ? 6 : endH) * 60 + (isNaN(endM) ? 0 : endM);

      let isSleeping = false;
      if (startMins > endMins) {
        // Over midnight sleep window (e.g. 22:00 to 06:00 next day)
        isSleeping = currentVal >= startMins || currentVal < endMins;
      } else {
        // Continuous daytime sleep window (e.g. 13:00 to 14:00)
        isSleeping = currentVal >= startMins && currentVal < endMins;
      }
      setIsPowerSavingMode(isSleeping);
    };

    checkScheduledSleep();
    const interval = setInterval(checkScheduledSleep, 15000); // Check every 15 seconds
    return () => clearInterval(interval);
  }, [sleepStart, sleepEnd, sleepBypassed]);

  // Helper to change map provider and persist it
  const handleMapProviderChange = (provider: 'leaflet' | 'yandex' | 'offline') => {
    setMapProvider(provider);
    localStorage.setItem('preferred_map_provider', provider);
  };

  // 6b. Leaflet Map Rendering and Updating Lifecycle
  useEffect(() => {
    if (mapProvider !== 'leaflet') {
      if (leafletMapRef.current) {
        try {
          leafletMapRef.current.remove();
        } catch (e) {
          console.error("Failed to remove Leaflet map instance:", e);
        }
        leafletMapRef.current = null;
      }
      return;
    }

    if (!leafletContainerRef.current) return;
    const L = (window as any).L;
    if (!L) {
      console.warn('Leaflet global library L is not yet loaded.');
      return;
    }

    // Creating Leaflet Map instance
    if (!leafletMapRef.current) {
      try {
        const initializedMap = L.map(leafletContainerRef.current, {
          center: [56.4977, 84.9744], // Center broadly near Russia / Tomsk TSUN
          zoom: 4,
          zoomControl: true,
          attributionControl: true
        });

        // Add CartoDB Voyager tiles (very clean look, full vector details)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
          subdomains: 'abcd',
          maxZoom: 20
        }).addTo(initializedMap);

        leafletMapRef.current = initializedMap;
      } catch (err) {
        console.error("Failed to configure Leaflet map container: ", err);
        return;
      }
    }

    // Process and sync active markers on Leaflet
    const activeQuery = searchQuery.toLowerCase().trim();
    const filtered = stations.filter(s => {
      const matchQuery = !activeQuery || 
        s.name.toLowerCase().includes(activeQuery) || 
        (s.city && s.city.toLowerCase().includes(activeQuery)) || 
        s.shortInfo.toLowerCase().includes(activeQuery);

      const matchType = filterType === 'all' || s.type === filterType;
      return matchQuery && matchType;
    });

    // Remove existing markers before rendering new ones
    leafletMarkersRef.current.forEach((m) => {
      try {
        m.remove();
      } catch (err) {
        console.error("Leaflet marker clear error: ", err);
      }
    });
    leafletMarkersRef.current = [];

    const bounds: any[] = [];

    filtered.forEach((s) => {
      let color = '#00509A'; // Rosatom Blue
      if (s.type === 'tpu') {
        color = '#007A33'; // TPU Green
      } else if (s.type === 'joint') {
        color = '#7e22ce'; // Joint Purple
      }

      const iconHtml = `
        <div class="relative flex items-center justify-center" style="width: 32px; height: 32px;">
          <div class="absolute inset-0 rounded-full animate-ping opacity-25" style="background-color: ${color}; animation-duration: 2s;"></div>
          <div class="w-7 h-7 rounded-full bg-white flex items-center justify-center shadow-lg border-2 hover:scale-110 transition-transform" style="border-color: ${color};">
            <div class="w-4 h-4 rounded-full flex items-center justify-center text-white" style="background-color: ${color}; font-size: 8px; font-weight: bold;">
              ☢
            </div>
          </div>
        </div>
      `;

      const customIcon = L.divIcon({
        html: iconHtml,
        className: 'custom-leaflet-pin',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -14]
      });

      // HTML template for popup card inside Leaflet map
      const badgeBorder = s.type === 'rosatom' ? '#dae6f5' : s.type === 'tpu' ? '#d1e7dd' : '#ebd9fc';
      const badgeBg = s.type === 'rosatom' ? '#eff6ff' : s.type === 'tpu' ? '#f8fdfa' : '#faf5ff';
      const badgeColor = s.type === 'rosatom' ? '#00509A' : s.type === 'tpu' ? '#007A33' : '#7e22ce';
      const badgeLabel = s.type === 'rosatom' ? 'ГК РОСАТОМ' : s.type === 'tpu' ? 'ТПУ' : 'СОВМЕСТНО';
      const btnBg = s.type === 'rosatom' ? '#00509A' : s.type === 'tpu' ? '#007A33' : '#7e22ce';

      const popupHtml = `
        <div style="font-family: system-ui, -apple-system, sans-serif; color: #1e293b; min-width: 250px; max-width: 300px; padding: 4px;">
          <strong style="font-size: 13px; color: #1e293b; display: block; margin-bottom: 6px;">${s.name}</strong>
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;">
            <span style="font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 6px; border-radius: 4px; border: 1px solid ${badgeBorder}; background-color: ${badgeBg}; color: ${badgeColor};">
              ${badgeLabel}
            </span>
            ${s.city ? `<span style="font-size: 10px; color: #64748b; font-weight: 600;">📍 ${s.city}</span>` : ''}
          </div>
          <p style="font-size: 11.5px; color: #475569; line-height: 1.4; margin: 0 0 10px 0; max-height: 90px; overflow-y: auto;">
            ${s.shortInfo}
          </p>
          <div style="display: flex; justify-content: space-between; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 4px 8px; font-family: monospace; font-size: 9px; color: #64748b; margin-bottom: 12px;">
            <span>ШИР: <strong>${s.lat.toFixed(5)}</strong></span>
            <span>ДОЛГ: <strong>${s.lon.toFixed(5)}</strong></span>
          </div>
          <button onclick="if(window.openStationDetails) { window.openStationDetails('${s.id}'); }" style="width: 100%; text-align: center; background-color: ${btnBg}; color: white; border: none; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 8px 12px; border-radius: 4px; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,0.05); transition: background-color 0.2s;">
            Получить полную информацию
          </button>
        </div>
      `;

      const marker = L.marker([s.lat, s.lon], { icon: customIcon })
        .bindPopup(popupHtml)
        .addTo(leafletMapRef.current);

      leafletMarkersRef.current.push(marker);
      bounds.push([s.lat, s.lon]);
    });

    if (bounds.length > 0 && leafletMapRef.current) {
      try {
        leafletMapRef.current.fitBounds(bounds, { padding: [50, 50], maxZoom: 10 });
      } catch (xe) {
        console.warn("Could not fit Leaflet bounds:", xe);
      }
    }
  }, [stations, searchQuery, filterType, mapProvider]);

  // 6. Yandex Maps Rendering and Updating lifecycle
  useEffect(() => {
    if (isMapOffline || !mapLibraryLoaded) return;
    // If we have Yandex script, initialize map container
    if (!mapContainerRef.current) return;
    const ymaps = (window as any).ymaps;
    if (!ymaps) {
      console.warn('Yandex Maps JS API SDK not yet fully loaded.');
      return;
    }

    ymaps.ready(() => {
      try {
        // Hide loading overlay pane
        const loaderPane = document.getElementById('map-loading-pane');
        if (loaderPane) {
          loaderPane.style.opacity = '0';
          setTimeout(() => {
            if (loaderPane) loaderPane.style.display = 'none';
          }, 600);
        }

        // If map instance is already created, skip creating and just refresh markers
        if (mapRef.current) return;

        const initializedMap = new ymaps.Map(mapContainerRef.current, {
          center: [55.0, 75.0], // Broadly centered to fit Eurasia scale
          zoom: 4,
          controls: ['zoomControl', 'typeSelector', 'fullscreenControl']
        }, {
          restrictMapArea: [
            [25.0, -10.0], // South-West corner (limits scrolling too far south/west)
            [78.0, 180.0]  // North-East corner (keeps North pole grey areas hidden)
          ],
          minZoom: 3,
          maxZoom: 16,
          avoidFractionalZoom: true
        });

        // Create a collection holding geo-points
        const geoObjects = new ymaps.GeoObjectCollection(null, {});
        initializedMap.geoObjects.add(geoObjects);

        mapRef.current = initializedMap;
        geoObjectsGroupRef.current = geoObjects;

        // Force updating placemarks for the first run
        refreshPins();
      } catch (err) {
        console.error("Failed to initialize Yandex Map, falling back to offline mode:", err);
        setIsMapOffline(true);
      }
    });
  }, [stations, mapLibraryLoaded, isMapOffline]);

  // Track map marker updates separately when station array changes
  useEffect(() => {
    refreshPins();
  }, [stations, filterType, searchQuery]);

  const refreshPins = () => {
    const ymaps = (window as any).ymaps;
    if (!ymaps || !mapRef.current || !geoObjectsGroupRef.current) return;

    const group = geoObjectsGroupRef.current;
    group.removeAll(); // Clear existing markers

    // Filter stations based on search queries and type
    const activeQuery = searchQuery.toLowerCase().trim();
    const filtered = stations.filter(s => {
      const matchQuery = !activeQuery || 
        s.name.toLowerCase().includes(activeQuery) || 
        (s.city && s.city.toLowerCase().includes(activeQuery)) || 
        s.shortInfo.toLowerCase().includes(activeQuery);

      const matchType = filterType === 'all' || s.type === filterType;
      return matchQuery && matchType;
    });

    const placemarksMap: Record<string, any> = {};

    filtered.forEach((s) => {
      // Custom presets based on affiliation
      let presetColor = 'islands#blueDotIcon'; // Rosatom Blue
      if (s.type === 'tpu') {
        presetColor = 'islands#greenDotIcon'; // TPU Green
      } else if (s.type === 'joint') {
        presetColor = 'islands#violetDotIcon'; // PURPLE Joint Projects
      }

      const badgeBorder = s.type === 'rosatom' ? '#dae6f5' : s.type === 'tpu' ? '#d1e7dd' : '#ebd9fc';
      const badgeBg = s.type === 'rosatom' ? '#eff6ff' : s.type === 'tpu' ? '#f8fdfa' : '#faf5ff';
      const badgeColor = s.type === 'rosatom' ? '#00509A' : s.type === 'tpu' ? '#007A33' : '#7e22ce';
      const badgeLabel = s.type === 'rosatom' ? 'ГК РОСАТОМ' : s.type === 'tpu' ? 'ТПУ' : 'СОВМЕСТНО';
      const btnBg = s.type === 'rosatom' ? '#00509A' : s.type === 'tpu' ? '#007A33' : '#7e22ce';

      const placemark = new ymaps.Placemark([s.lat, s.lon], {
        balloonContentHeader: `<strong style="font-family: sans-serif; font-size: 13px; color: #1e293b; display: block; margin-top: 4px;">${s.name}</strong>`,
        balloonContentBody: `
          <div style="font-family: system-ui, -apple-system, sans-serif; color: #1e293b; min-width: 250px; max-width: 320px; padding: 4px 0;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;">
              <span style="font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 6px; border-radius: 4px; border: 1px solid ${badgeBorder}; background-color: ${badgeBg}; color: ${badgeColor};">
                ${badgeLabel}
              </span>
              ${s.city ? `<span style="font-size: 10px; color: #64748b; font-weight: 600;">📍 ${s.city}</span>` : ''}
            </div>
            <p style="font-size: 11.5px; color: #475569; line-height: 1.4; margin: 0 0 10px 0; max-height: 90px; overflow-y: auto;">
              ${s.shortInfo}
            </p>
            <div style="display: flex; justify-content: space-between; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 4px 8px; font-family: monospace; font-size: 9px; color: #64748b; margin-bottom: 12px;">
              <span>ШИР: <strong style="color: #00509A;">${s.lat.toFixed(5)}</strong></span>
              <span>ДОЛГ: <strong style="color: #00509A;">${s.lon.toFixed(5)}</strong></span>
            </div>
            <button onclick="if(window.openStationDetails) { window.openStationDetails('${s.id}'); }" style="width: 100%; text-align: center; background-color: ${btnBg}; color: white; border: none; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 8px 12px; border-radius: 4px; cursor: pointer; box-shadow: 0 1px 2px rgba(0,0,0,0.05); transition: background-color 0.2s;" onmouseover="this.style.filter='brightness(0.95)'" onmouseout="this.style.filter='none'">
              Получить полную информацию
            </button>
          </div>
        `,
        hintContent: s.name
      }, {
        preset: presetColor,
        hideIconOnBalloonOpen: false
      });

      // Map click handler - we still track the selected station for any reference
      placemark.events.add('click', () => {
        setSelectedStation(s);
      });

      placemarksMap[s.id] = placemark;
      group.add(placemark);
    });

    placemarksRef.current = placemarksMap;

    // Automatically fit map zoom bounds to encompass all shown points
    if (filtered.length > 0) {
      try {
        const bounds = group.getBounds();
        if (bounds) {
          mapRef.current.setBounds(bounds, {
            checkZoomRange: true,
            zoomMargin: 100
          });
        }
      } catch (err) {
        console.warn('Could not auto-fit coordinates bounds: ', err);
      }
    }
  };

  // Helper theme colors mapping
  const currentBgHeader = theme === 'rosatom' ? 'bg-[#00509A] text-white' : 'bg-[#007A33] text-white';

  return (
    <div className="relative w-screen h-screen flex flex-col overflow-hidden bg-slate-50 font-sans select-none text-slate-800">
      
      {/* 1. Nocturnal Energy-safe sleep mode blackout */}
      {isPowerSavingMode && (
        <SleepOverlay 
          sleepStart={sleepStart} 
          sleepEnd={sleepEnd} 
          onBypass={() => {
            setSleepBypassed(true);
            setIsPowerSavingMode(false);
            // Re-trigger sleep state checking in 15 minutes automatically
            setTimeout(() => setSleepBypassed(false), 900000); 
          }}
        />
      )}

      {/* 2. Slide Out Admin Panel Panel */}
      {isAdminOpen && (
        <AdminPanel
          stations={stations}
          onAddStation={handleAddStation}
          onDeleteStation={handleDeleteStation}
          onImportStations={handleImportStations}
          isFirebaseActive={isFirebaseEnabled}
          onSyncWithCloud={handleManualSyncWithCloud}
          sleepStart={sleepStart}
          sleepEnd={sleepEnd}
          onChangeSleepHours={handleChangeSleepHours}
          onClose={() => setIsAdminOpen(false)}
        />
      )}

      {/* 3. Primary Fullscreen Window Module */}
      <div className="flex-1 flex flex-col h-full relative overflow-hidden">
        
        {/* Upper Banner / Corporate Navigation Header */}
        <header className={`${currentBgHeader} h-16 px-6 shadow-md z-50 flex items-center justify-between gap-4 flex-shrink-0 transition-all`}>
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center p-1.5 shadow-sm select-none">
              {/* Rosatom Official Logo Symbol (Möbius Orbit Globe) */}
              <svg viewBox="0 0 100 100" className="w-8 h-8 select-none" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="50" cy="50" r="48" fill="#00509A" />
                <path d="M 50 14 C 69.9 14, 86 30.1, 86 50 C 70 50, 50 30, 50 14 Z" fill="white" />
                <path d="M 50 86 C 30.1 86, 14 69.9, 14 50 C 30 50, 50 70, 50 86 Z" fill="white" />
                <path d="M 14 50 C 14 30.1, 30.1 14, 50 14 C 50 30, 30 50, 14 50 Z" fill="white" />
                <path d="M 86 50 C 86 69.9, 69.9 86, 50 86 C 50 70, 70 50, 86 50 Z" fill="white" />
                <circle cx="50" cy="50" r="18" fill="#00509A" />
                <circle cx="50" cy="50" r="10" fill="white" />
              </svg>
            </div>
            
            <div className="h-8 w-px bg-white/20 hidden md:block"></div>
            
            <div className="flex flex-col text-white">
              <div className="flex items-center space-x-2">
                <span className="text-base md:text-lg font-bold tracking-tight uppercase">Интерактивная карта предприятий</span>
                <span className="hidden sm:inline-block text-[9px] bg-white/10 px-1.5 py-0.2 rounded font-mono text-white/90">v4.2.1</span>
              </div>
            </div>
          </div>

          {/* Quick Stats Banner & Live controls */}
          <div className="flex items-center gap-4">
            {/* Clock & Status */}
            <div className="flex flex-col items-end text-white text-right hidden md:flex">
              <span className="text-sm font-medium leading-none font-mono">{new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="text-[9px] opacity-70 mt-0.5 uppercase tracking-wide">Система активна (Сон в {sleepStart})</span>
            </div>
            <div className="w-3 h-3 bg-green-400 rounded-full shadow-[0_0_8px_rgba(74,222,128,0.6)] hidden md:block" title="Система активна"></div>
            
            {/* Полноэкранный режим */}
            <button
              onClick={toggleFullscreen}
              className="cursor-pointer bg-white/10 hover:bg-white/15 border border-white/15 text-white p-2 rounded text-xs transition-all flex items-center justify-center hover:scale-105 active:scale-95"
              title={isFullscreen ? "Выйти из полноэкранного режима" : "Развернуть на весь экран"}
            >
              {isFullscreen ? (
                <Minimize className="w-3.5 h-3.5 text-white/90" />
              ) : (
                <Maximize className="w-3.5 h-3.5 text-white/90" />
              )}
            </button>
            
            {/* Admin trigger shortcuts */}
            <button
              onClick={() => setIsAdminOpen(p => !p)}
              className="cursor-pointer bg-white/10 hover:bg-white/15 border border-white/15 text-white px-3 py-1.5 rounded text-xs font-mono font-medium flex items-center space-x-1.5 transition-all"
              title="Открыть консоль администратора (Ctrl+Alt+A)"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-white/80" />
              <span className="hidden lg:inline text-white/90 font-sans">Панель</span>
              <kbd className="hidden sm:inline-block px-1 py-0.2 bg-white/10 border border-white/15 text-[8px] rounded font-mono text-white/80">
                Ctrl+Alt+A
              </kbd>
            </button>
          </div>
        </header>

        {/* 4. Main workspace grid layout */}
        <div className="flex-1 flex flex-col md:flex-row min-h-0 relative overflow-hidden">
          


          {/* Map display workspace and information overlays */}
          <main className="flex-1 h-full relative flex flex-col min-w-0">
            {/* 1. Map Type Switcher Floating Control Bar (Always visible and accessible) */}
            <div className="absolute top-4 left-4 z-40 bg-white/95 border border-slate-300 backdrop-blur rounded shadow-xl p-1 flex items-center gap-1 select-none pointer-events-auto">
              <button
                onClick={() => handleMapProviderChange('leaflet')}
                className={`px-3 py-1.5 rounded text-xs font-semibold cursor-pointer transition-all flex items-center gap-1.5 ${
                  mapProvider === 'leaflet'
                    ? 'bg-[#00509A] text-white shadow-md font-bold'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
                title="Обычная реальная карта (Картография OpenStreetMap) — работает гарантированно отовсюду"
              >
                <Globe className="w-3.5 h-3.5" />
                <span>Реальная карта (OSM)</span>
              </button>
              <button
                onClick={() => handleMapProviderChange('yandex')}
                className={`px-3 py-1.5 rounded text-xs font-semibold cursor-pointer transition-all flex items-center gap-1.5 ${
                  mapProvider === 'yandex'
                    ? 'bg-[#00509A] text-white shadow-md font-bold'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
                title="Официальные Яндекс.Карты (требуется рабочий API-ключ разработчика)"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Яндекс.Карты</span>
              </button>
              <button
                onClick={() => handleMapProviderChange('offline')}
                className={`px-3 py-1.5 rounded text-xs font-semibold cursor-pointer transition-all flex items-center gap-1.5 ${
                  mapProvider === 'offline'
                    ? 'bg-[#00509A] text-white shadow-md font-bold'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
                title="Схематичная интерактивная оффлайн-карта с портом для работы полностью без интернета"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>Оффлайн схема</span>
              </button>
            </div>

            {/* 2. Choose and Render Map Instance */}
            {mapProvider === 'offline' ? (
              <OfflineMap
                stations={stations}
                activeDetails={activeDetails}
                setActiveDetails={setActiveDetails}
                searchQuery={searchQuery}
                filterType={filterType}
                theme={theme}
              />
            ) : mapProvider === 'leaflet' ? (
              <>
                {/* Leaflet Interactive Map Container */}
                <div id="leaflet-map" ref={leafletContainerRef} className="w-full h-full relative z-10" style={{ minHeight: '350px' }}></div>

                {/* Floating Top Cloud Sync Banner on the Map */}
                <div className="absolute top-4 right-4 z-20 pointer-events-none">
                  <div className="bg-white/90 border border-slate-300 backdrop-blur rounded px-3 py-1 flex items-center gap-3 shadow-sm text-slate-700 font-mono">
                    <span className="text-[9px] text-slate-400 uppercase tracking-wider font-bold">ОБЛАЧНАЯ СИНХРОНИЗАЦИЯ:</span>
                    <span className="text-[10px] text-green-600 font-bold tracking-wider">ОБНОВЛЕНО</span>
                  </div>
                </div>

                {/* Map Legend Card */}
                <div className="absolute bottom-4 left-4 w-52 bg-white/95 backdrop-blur border border-slate-300 rounded shadow-xl p-3 z-20 pointer-events-auto">
                  <h4 className="text-[10px] font-mono font-bold text-slate-800 tracking-wider uppercase mb-1 flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5 text-[#00509A]" />
                    <span>ЛЕГЕНДА КАРТЫ (OSM)</span>
                  </h4>
                  <p className="text-[10px] text-slate-600 leading-snug">
                    Кликните на метку, чтобы открыть всплывающую карточку, а затем кнопку получения информации.
                  </p>
                  <div className="mt-2.5 pt-2 border-t border-slate-200/70 flex flex-col gap-1 text-[9px] font-mono text-slate-500">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 bg-[#007A33] rounded-full shadow-[0_0_4px_rgba(0,122,51,0.3)]"></div>
                      <span className="font-medium">ТПУ</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 bg-[#00509A] rounded-full shadow-[0_0_4px_rgba(0,80,154,0.3)]"></div>
                      <span className="font-medium font-bold text-[#00509A]">Росатом</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 bg-purple-600 rounded-full shadow-[0_0_4px_rgba(147,51,234,0.3)]"></div>
                      <span className="font-medium">Совместные</span>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Yandex Map Container */}
                <div id="map" ref={mapContainerRef} className="w-full h-full relative" style={{ minHeight: '350px' }}>
                  {/* Spinner loader while map SDK ready */}
                  <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-sm z-10 flex flex-col items-center justify-center space-y-4 pointer-events-auto transition-all duration-700 select-none text-center p-6" id="map-loading-pane">
                    <div className="flex items-center space-x-3">
                      <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
                      <span className="text-xs font-mono text-slate-400">ГЕНЕРАЦИЯ ГЕОКАРТЫ YANDEX MAPS...</span>
                    </div>
                    
                    <div className="bg-slate-900 border border-slate-800 p-4 rounded-lg max-w-sm shadow-xl mt-2 select-none pointer-events-auto">
                      <p className="text-[11px] text-slate-400 mb-3 leading-relaxed">
                        Если Яндекс.Карты зависают во фрейме из-за ограничений домена или отсутствия ключа, переключитесь на <strong>Реальную карту (OSM)</strong>, которая грузится моментально без ключей.
                      </p>
                      <button 
                        onClick={() => handleMapProviderChange('leaflet')}
                        className="cursor-pointer bg-[#00509A] hover:bg-blue-600 text-white text-[11px] px-3 py-1.5 rounded font-bold transition duration-200 active:scale-95 inline-flex items-center gap-1"
                      >
                        <Globe className="w-3.5 h-3.5" />
                        <span>Открыть карту OpenStreetMap</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Floating Top Cloud Sync Banner on the Map */}
                <div className="absolute top-4 right-4 z-20 pointer-events-none">
                  <div className="bg-white/90 border border-slate-300 backdrop-blur rounded px-3 py-1 flex items-center gap-3 shadow-sm text-slate-700 font-mono">
                    <span className="text-[9px] text-slate-400 uppercase tracking-wider font-bold">ОБЛАЧНАЯ СИНХРОНИЗАЦИЯ:</span>
                    <span className="text-[10px] text-green-600 font-bold tracking-wider">ОБНОВЛЕНО</span>
                  </div>
                </div>

                {/* HIGH-DENSITY MAP LEGEND CARD */}
                <div className="absolute bottom-4 left-4 w-52 bg-white/95 backdrop-blur border border-slate-300 rounded shadow-xl p-3 z-20 pointer-events-auto">
                  <h4 className="text-[10px] font-mono font-bold text-slate-800 tracking-wider uppercase mb-1 flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5 text-[#00509A]" />
                    <span>ЛЕГЕНДА КАРТЫ (YANDEX)</span>
                  </h4>
                  <p className="text-[10px] text-slate-600 leading-snug">
                    Наведите на точку на карте, чтобы увидеть детали местоположения и краткую сводку по предприятию.
                  </p>
                  <div className="mt-2.5 pt-2 border-t border-slate-200/70 flex flex-col gap-1 text-[9px] font-mono text-slate-500">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 bg-[#00509A] rounded-full shadow-[0_0_4px_rgba(0,80,154,0.3)]"></div>
                      <span className="font-medium">ТПУ</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 bg-[#00ADEF] rounded-full shadow-[0_0_4px_rgba(0,173,239,0.3)]"></div>
                      <span className="font-medium font-bold text-[#00509A]">Росатом</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 bg-purple-600 rounded-full shadow-[0_0_4px_rgba(147,51,234,0.3)]"></div>
                      <span className="font-medium">Совместные</span>
                    </div>
                  </div>
                </div>
              </>
            )}
          </main>
        </div>

        {/* Corporate footer block matching High Density spec exactly */}
        <footer className="h-8 bg-slate-900 border-t border-slate-800 flex items-center px-6 justify-between flex-shrink-0 z-40 select-none">
          <span className="text-[9px] text-white/50 tracking-wider uppercase underline-offset-4 decoration-white/20">
            © 2026 Государственная корпорация по атомной энергии «Росатом»
          </span>
          <div className="hidden sm:flex gap-4">
            <span className="text-[9px] text-white/40 uppercase">Подключение: Cloud-SSL Encrypted</span>
            <span className="text-[9px] text-white/40 uppercase font-mono">Версия ПО: 4.2.1-GOLD</span>
          </div>
        </footer>

      </div>

      {/* 5. Immersive immersive inspection detail overlay dialog */}
      {activeDetails && (
        <DetailsModal
          station={activeDetails}
          theme={theme}
          onClose={() => setActiveDetails(null)}
        />
      )}

    </div>
  );
}
