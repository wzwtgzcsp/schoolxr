/**
 * XR 户外导航 - 主入口
 * 
 * 基于 gps-plus-slam-app-framework
 * 参考 GpsPlusSlamJs_AnchorStarter/src/main.ts
 */

import { createSlamAppStore } from 'gps-plus-slam-app-framework/state';
import { initAR, getArWorldGroup, getCamera } from 'gps-plus-slam-app-framework/ar';
import { startGpsWatch } from 'gps-plus-slam-app-framework/sensors';
import { createGpsAnchor } from 'gps-plus-slam-app-framework/visualization';
import { approxDistanceMetres } from 'gps-plus-slam-app-framework/geo';
import { NullStorageBackend } from 'gps-plus-slam-app-framework/storage';
import * as THREE from 'three';

// ===== 应用状态 =====
const state = {
  arReady: false,
  navigating: false,
  currentTarget: null,      // { lat, lng, name }
  currentUserPos: null,     // { lat, lng }
  targetAnchor: null,       // createGpsAnchor 返回的锚点
  pathLine: null,           // 路径线
  pathArrows: [],           // 路径上的箭头
  proximityThreshold: 10,   // 接近阈值（米）
  flashInterval: null,
};

// ===== DOM 引用 =====
const statusBar = document.getElementById('status-bar');
const proximityFlash = document.getElementById('proximity-flash');
const startPrompt = document.getElementById('start-prompt');
const startBtn = document.getElementById('start-btn');
const locationItems = document.querySelectorAll('.location-item');

// ===== 工具函数 =====
function setStatus(text, cls = '') {
  if (statusBar) {
    statusBar.textContent = text;
    statusBar.className = cls;
  }
}

// ===== 启动 AR 会话 =====
async function startAR() {
  if (startPrompt) startPrompt.style.display = 'none';
  setStatus('正在启动 AR...', '');

  try {
    // 1. 检查 WebXR 支持
    if (!navigator.xr) {
      setStatus('此设备不支持 WebXR', '');
      return;
    }
    const supported = await navigator.xr.isSessionSupported('immersive-ar');
    if (!supported) {
      setStatus('此设备不支持 AR 模式', '');
      return;
    }

    // 2. 创建 Store（使用 NullStorageBackend，不持久化）
    const store = createSlamAppStore({
      storageBackend: new NullStorageBackend(),
    });

    // 3. 初始化 AR
    // 关键：callbacks.tracking 必须传入 store，否则 tracking.phase 会卡在 initializing [citation:1]
    const container = document.getElementById('app');
    await initAR(container, false, {
      requestHitTest: true,
      callbacks: {
        tracking: {
          store,
          onRestarted: (payload) => {
            console.log('AR 追踪已重启:', payload);
          },
        },
      },
    });

    // 4. 获取 AR 世界组（用于放置 GPS 锚点）
    const arWorldGroup = getArWorldGroup();

    // 5. 启动 GPS 监听
    startGpsWatch(
      (position) => {
        state.currentUserPos = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        // GPS 更新时检查是否接近目标
        checkProximity();
        // 更新导航状态栏
        updateNavigationStatus();
      },
      (error) => {
        console.warn('GPS 错误:', error);
        setStatus('GPS 信号弱，请走到户外', '');
      }
    );

    state.arReady = true;
    setStatus('AR 已就绪，请走动几步完成定位', 'ready');

    // 6. 绑定位置列表点击
    locationItems.forEach((item) => {
      item.addEventListener('click', () => selectTarget(item, arWorldGroup));
    });

    // 7. 暴露全局引用，方便调试
    window.__xrNav = { state, store, arWorldGroup };

  } catch (err) {
    console.error('AR 启动失败:', err);
    setStatus('AR 启动失败: ' + err.message, '');
    if (startPrompt) startPrompt.style.display = 'block';
  }
}

// ===== 选择导航目标 =====
function selectTarget(item, arWorldGroup) {
  // 更新 UI 选中状态
  locationItems.forEach((i) => i.classList.remove('selected'));
  item.classList.add('selected');

  const lat = parseFloat(item.dataset.lat);
  const lng = parseFloat(item.dataset.lng);
  const name = item.dataset.name;

  state.currentTarget = { lat, lng, name };
  state.navigating = true;

  setStatus(`导航中: ${name}`, 'navigating');

  // 创建 3D 导航视觉（目标标记 + 路径）
  createNavigationVisuals(arWorldGroup);

  // 立即检查一次接近状态
  checkProximity();
}

// ===== 创建导航视觉（目标标记 + 路径） =====
function createNavigationVisuals(arWorldGroup) {
  if (!state.currentTarget || !state.currentUserPos) {
    console.warn('缺少目标或用户位置，无法创建导航视觉');
    return;
  }

  // 清理旧的导航视觉
  cleanupNavigationVisuals();

  // 1. 创建目标标记（一个浮空的球体）
  const targetGeometry = new THREE.SphereGeometry(0.3, 16, 16);
  const targetMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff88 });
  const targetMesh = new THREE.Mesh(targetGeometry, targetMaterial);
  targetMesh.position.y = 1.2; // 离地约 1.2 米

  // 必须先将 mesh 添加到 arWorldGroup，然后才能传给 createGpsAnchor [citation:39]
  arWorldGroup.add(targetMesh);

  // 2. 用 createGpsAnchor 锚定目标标记到 GPS 坐标
  // createGpsAnchor 要求对象必须是 arWorldGroup 的后代，否则会抛异常 [citation:10]
  const anchor = createGpsAnchor({
    object3D: targetMesh,
    arWorldGroup,
    camera: getCamera(),
    gpsPoint: { lat: state.currentTarget.lat, lon: state.currentTarget.lng },
    getAlignmentMatrix: () => window.__xrNav?.store?.getState()?.gpsData?.alignmentMatrix ?? null,
    getGpsZeroRef: () => window.__xrNav?.store?.getState()?.gpsData?.zero ?? null,
    mode: 'snap-when-offscreen', // 修正推迟到物体移出视野时，避免用户看着物体“跳走” [citation:30]
  });

  state.targetAnchor = anchor;

  // 3. 创建“红地毯”路径（用 Ribbon 模拟）
  createPathRibbon(arWorldGroup);

  console.log('导航视觉已创建，目标:', state.currentTarget);
}

// ===== 创建红地毯路径 =====
function createPathRibbon(arWorldGroup) {
  // 注意：GPS 坐标是经纬度，而 Three.js 场景使用局部坐标。
  // 简单做法：在用户和目标之间创建一条直线路径（视觉上指向大致方向）。
  // 更精确的做法需要用 GPS 坐标插值后转换为局部坐标。

  const userPos = state.currentUserPos;
  const targetPos = state.currentTarget;
  if (!userPos || !targetPos) return;

  // 计算两点间的近似距离（米）
  const distance = approxDistanceMetres(
    { lat: userPos.lat, lng: userPos.lng },
    { lat: targetPos.lat, lng: targetPos.lng }
  );

  // 限制路径长度（太远的话用最大视觉长度）
  const maxVisualLength = 20; // 米
  const visualLength = Math.min(distance, maxVisualLength);

  // 创建 Ribbon 路径：两条平行的线构成“地毯”
  const pathPoints = [];
  const segments = 20;
  const ribbonWidth = 0.4;

  // 路径沿着 -Z 方向延伸（AR 相机看向 -Z）
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const z = -t * visualLength;
    // 左侧点
    pathPoints.push(new THREE.Vector3(-ribbonWidth / 2, 0.05, z));
  }

  const pathPoints2 = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const z = -t * visualLength;
    // 右侧点
    pathPoints2.push(new THREE.Vector3(ribbonWidth / 2, 0.05, z));
  }

  const ribbonGeometry = new THREE.BufferGeometry();
  // 用 PlaneGeometry 或自定义 BufferGeometry 创建地毯
  // 简化：用一个宽平面的 Box 或 Plane 来代表地毯
  const planeGeometry = new THREE.PlaneGeometry(ribbonWidth, visualLength);
  const planeMaterial = new THREE.MeshBasicMaterial({
    color: 0xff3333,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.6,
  });
  const ribbon = new THREE.Mesh(planeGeometry, planeMaterial);
  ribbon.rotation.x = -Math.PI / 2; // 平躺在地面上
  ribbon.position.z = -visualLength / 2;
  ribbon.position.y = 0.05;

  arWorldGroup.add(ribbon);
  state.pathLine = ribbon;

  // 在路径终点添加一个箭头
  const arrowGeometry = new THREE.ConeGeometry(0.15, 0.4, 8);
  const arrowMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
  const arrow = new THREE.Mesh(arrowGeometry, arrowMaterial);
  arrow.rotation.x = -Math.PI / 2; // 箭头朝前
  arrow.position.set(0, 0.1, -visualLength);
  arWorldGroup.add(arrow);
  state.pathArrows.push(arrow);

  console.log(`路径已创建，长度 ${visualLength.toFixed(1)} 米（实际距离 ${distance.toFixed(1)} 米）`);
}

// ===== 清理旧的导航视觉 =====
function cleanupNavigationVisuals() {
  // 清理目标锚点
  if (state.targetAnchor) {
    try {
      state.targetAnchor.dispose();
    } catch (e) {
      console.warn('清理锚点失败:', e);
    }
    state.targetAnchor = null;
  }

  // 清理路径
  if (state.pathLine) {
    state.pathLine.parent?.remove(state.pathLine);
    state.pathLine.geometry?.dispose();
    state.pathLine.material?.dispose();
    state.pathLine = null;
  }

  // 清理箭头
  state.pathArrows.forEach((arrow) => {
    arrow.parent?.remove(arrow);
    arrow.geometry?.dispose();
    arrow.material?.dispose();
  });
  state.pathArrows = [];
}

// ===== 检查是否接近目标 =====
function checkProximity() {
  if (!state.navigating || !state.currentTarget || !state.currentUserPos) {
    return;
  }

  const dist = approxDistanceMetres(
    { lat: state.currentUserPos.lat, lng: state.currentUserPos.lng },
    { lat: state.currentTarget.lat, lng: state.currentTarget.lng }
  );

  if (dist <= state.proximityThreshold) {
    startProximityFlash();
  } else {
    stopProximityFlash();
  }
}

// ===== 更新导航状态栏 =====
function updateNavigationStatus() {
  if (!state.navigating || !state.currentTarget || !state.currentUserPos) return;

  const dist = approxDistanceMetres(
    { lat: state.currentUserPos.lat, lng: state.currentUserPos.lng },
    { lat: state.currentTarget.lat, lng: state.currentTarget.lng }
  );

  setStatus(`导航中: ${state.currentTarget.name} — 距离 ${dist.toFixed(0)} 米`, 'navigating');
}

// ===== 绿色闪烁效果 =====
function startProximityFlash() {
  if (state.flashInterval) return;

  let visible = false;
  state.flashInterval = setInterval(() => {
    visible = !visible;
    if (proximityFlash) {
      proximityFlash.style.background = visible
        ? 'rgba(0, 255, 80, 0.25)'
        : 'rgba(0, 255, 80, 0)';
    }
  }, 300);
}

function stopProximityFlash() {
  if (state.flashInterval) {
    clearInterval(state.flashInterval);
    state.flashInterval = null;
  }
  if (proximityFlash) {
    proximityFlash.style.background = 'rgba(0, 255, 80, 0)';
  }
}

// ===== 启动按钮 =====
if (startBtn) {
  startBtn.addEventListener('click', startAR);
}

// ===== 页面加载检查 =====
window.addEventListener('load', async () => {
  if (!navigator.xr) {
    setStatus('此设备/浏览器不支持 WebXR', '');
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = '设备不支持';
    }
    return;
  }
  const supported = await navigator.xr.isSessionSupported('immersive-ar');
  if (!supported) {
    setStatus('此设备不支持 AR 模式', '');
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.textContent = '设备不支持';
    }
  } else {
    setStatus('准备就绪', 'ready');
  }
});