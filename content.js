// content.js - Fixed version with proper serialization and error handling
console.log('Netflix Together content script loaded');

let overlayInjected = false;
let videoElement = null;
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let videoSyncInterval = null;
let lastKnownTime = 0;
let lastKnownPlaybackState = false;
let ignoreNextTimeUpdate = false;
let mediaPermissionsRequested = false;
let currentRoomCode = null;
let currentIsHost = false;
let offerCreated = false;
let pendingCandidates = [];
let waitingForRemoteDescription = false;

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Message received in content script:', message);

  if (message.action === "injectOverlay" && !overlayInjected) {
    // Store these globally for recovery purposes
    currentRoomCode = message.roomCode;
    currentIsHost = message.isHost === true; // Use strict equality
    
    console.log('Attempting to inject overlay for room:', message.roomCode, 'isHost:', currentIsHost);
    injectOverlay(message.roomCode, currentIsHost);
    // IMPORTANT: Send response immediately to avoid "message channel closed" error
    sendResponse({success: true});
  }
  
  if (message.action === "removeOverlay" && overlayInjected) {
    console.log('Removing overlay');
    removeOverlay();
    // IMPORTANT: Send response immediately
    sendResponse({success: true});
  }
  
  // DO NOT return true here - this was causing the "message channel closed" error
  // Only return true if you're using an async function with sendResponse
});

// Function to inject a script from extension resources
function injectScript(scriptName) {
  return new Promise((resolve, reject) => {
    console.log(`Injecting script: ${scriptName}`);
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(scriptName);
    script.onload = () => {
      console.log(`${scriptName} loaded successfully`);
      resolve();
    };
    script.onerror = (error) => {
      console.error(`Error loading ${scriptName}:`, error);
      reject(error);
    };
    (document.head || document.documentElement).appendChild(script);
  });
}

// Main functions
async function injectOverlay(roomCode, isHost) {
  console.log('Starting overlay injection process for room:', roomCode, 'isHost:', isHost);
  
  try {
    // Create overlay container
    const overlayContainer = document.createElement('div');
    overlayContainer.id = 'netflix-together-overlay';
    document.body.appendChild(overlayContainer);
    
    console.log('Overlay container added to page');
    
    // Load the overlay HTML
    const response = await fetch(chrome.runtime.getURL('overlay.html'));
    const html = await response.text();
    overlayContainer.innerHTML = html;
    console.log('Overlay HTML loaded');
    
    // Initialize the UI components
    initializeOverlayUI();
    
    // Set up room code display
    const roomCodeDisplay = document.getElementById('room-code');
    if (roomCodeDisplay) {
      roomCodeDisplay.textContent = roomCode;
    }
    
    // Identify the video player on the page
    findVideoPlayer();
    
    // First inject Socket.io, then page script
    await injectScript('socket.io.js');
    await injectScript('page-script.js');
    
    // Set up event listeners for communication from page script
    setupPageScriptEventListeners(roomCode, isHost);
    
    // Set up video synchronization if we have a video element
    if (videoElement) {
      setupVideoSync();
    } else {
      // Try to find video later and set up sync
      const videoCheckInterval = setInterval(() => {
        findVideoPlayer();
        if (videoElement) {
          setupVideoSync();
          clearInterval(videoCheckInterval);
        }
      }, 2000);
    }
    
    // Create emergency recovery button (hidden by default)
    const recoveryButton = document.createElement('button');
    recoveryButton.textContent = 'Emergency Recovery';
    recoveryButton.id = 'netflix-together-recovery';
    recoveryButton.style.cssText = 'position:fixed;top:50px;left:10px;background:#f00;color:#fff;border:none;padding:5px 10px;border-radius:5px;z-index:99999;display:none;';
    recoveryButton.onclick = function() {
      console.log('Emergency recovery clicked');
      window.postMessage({
        type: 'NETFLIX_TOGETHER_EMERGENCY_RECOVERY',
        roomCode: roomCode,
        isHost: isHost
      }, '*');
    };
    document.body.appendChild(recoveryButton);
    
    // Show emergency button after 30 seconds if no partner connects
    setTimeout(() => {
      const partnerConnected = document.querySelector('.partner-connected') !== null;
      if (!partnerConnected) {
        recoveryButton.style.display = 'block';
      }
    }, 30000);
    
    overlayInjected = true;
    
    // Add diagnostics buttons right away for easier debugging
    addDiagnosticsAndFixButtons();
    
    // NEW: Add emergency chat button
    addEmergencyChatButton();
  } catch (error) {
    console.error('Error injecting overlay:', error);
    const errorDiv = document.createElement('div');
    errorDiv.textContent = 'Error loading Netflix Together overlay: ' + error.message;
    errorDiv.style.cssText = 'position:fixed; top:10px; left:10px; background:red; color:white; padding:10px; z-index:10000';
    document.body.appendChild(errorDiv);
  }

  const debugButton = document.getElementById('netflix-together-debug');
  if (debugButton) {
    debugButton.style.display = 'block';
    debugButton.addEventListener('click', () => {
      window.debugWebRTC();
    });
  }
}

function removeOverlay() {
  console.log('Cleaning up and removing overlay');
  
  // Clean up WebRTC connections
  if (localStream) {
    console.log('Stopping local media streams');
    localStream.getTracks().forEach(track => track.stop());
  }
  
  if (peerConnection) {
    console.log('Closing peer connection');
    peerConnection.close();
    peerConnection = null;
  }
  
  // Tell page context to disconnect socket
  window.postMessage({
    type: 'NETFLIX_TOGETHER_DISCONNECT'
  }, '*');
  
  // Clear sync interval
  if (videoSyncInterval) {
    clearInterval(videoSyncInterval);
  }
  
  // Remove event listeners from video element
  if (videoElement) {
    console.log('Removing video event listeners');
    videoElement.removeEventListener('play', handleVideoPlay);
    videoElement.removeEventListener('pause', handleVideoPause);
    videoElement.removeEventListener('seeking', handleVideoSeeking);
  }
  
  // Remove the overlay and any recovery buttons
  const overlay = document.getElementById('netflix-together-overlay');
  if (overlay) {
    console.log('Removing overlay DOM elements');
    overlay.remove();
  }
  
  const recoveryButton = document.getElementById('netflix-together-recovery');
  if (recoveryButton) {
    recoveryButton.remove();
  }
  
  overlayInjected = false;
}

function findVideoPlayer() {
  console.log('Searching for video player on page');
  
  // Different selectors for different streaming services
  const selectors = [
    'video', // Generic
    '.netflix-player video', // Netflix
    '.video-stream', // YouTube
    '.video-player video', // Hulu
    '.html5-video-container video' // Various others
  ];
  
  for (const selector of selectors) {
    const elements = document.querySelectorAll(selector);
    console.log(`Found ${elements.length} elements matching selector: ${selector}`);
    
    for (const element of elements) {
      if (element instanceof HTMLVideoElement) {
        console.log('Found potential video element:', element);
        
        // Check if it's actually a video player and not just a hidden element
        if (element.offsetWidth > 0 && element.offsetHeight > 0) {
          videoElement = element;
          console.log('Selected video element with dimensions:', element.offsetWidth, 'x', element.offsetHeight);
          return;
        }
      }
    }
  }
  
  console.log('No suitable video element found on this iteration');
}

function initializeOverlayUI() {
  console.log('Initializing overlay UI components');
  
  // Get UI elements
  const chatToggleBtn = document.getElementById('chat-toggle');
  const micToggleBtn = document.getElementById('mic-toggle');
  const cameraToggleBtn = document.getElementById('camera-toggle');
  const chatContainer = document.getElementById('chat-container');
  const messageInput = document.getElementById('message-input');
  const sendMsgBtn = document.getElementById('send-message');
  const messagesContainer = document.getElementById('messages-container');
  const localVideo = document.getElementById('local-video');
  const remoteVideo = document.getElementById('remote-video');
  const closeButton = document.getElementById('close-overlay');
  
  // Set up click handlers
  if (chatToggleBtn && chatContainer) {
    console.log('Setting up chat toggle');
    chatToggleBtn.addEventListener('click', () => {
      chatContainer.classList.toggle('hidden');
    });
  }
  
  if (micToggleBtn) {
    console.log('Setting up mic toggle');
    micToggleBtn.addEventListener('click', () => {
      toggleMicrophone();
    });
  }
  
  if (cameraToggleBtn) {
    console.log('Setting up camera toggle');
    cameraToggleBtn.addEventListener('click', () => {
      toggleCamera();
    });
  }
  
  if (sendMsgBtn && messageInput) {
    console.log('Setting up message sending');
    sendMsgBtn.addEventListener('click', () => {
      sendChatMessage();
    });
    
    messageInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        sendChatMessage();
      }
    });
  }
  
  if (closeButton) {
    console.log('Setting up close button');
    closeButton.addEventListener('click', () => {
      chrome.runtime.sendMessage({action: 'endSession'}, (response) => {
        // Handle response if needed
        console.log('End session response:', response);
      });
    });
  }
  
  // Set up video elements
  if (localVideo) {
    console.log('Setting up local video element');
    localVideo.muted = true; // Mute local video to prevent echo
    localVideo.setAttribute('playsinline', ''); // Ensure it can play inline on mobile
  }
  
  if (remoteVideo) {
    remoteVideo.setAttribute('playsinline', '');
    remoteVideo.setAttribute('autoplay', '');
  }
  enhanceInitializeUI();
  fixChatButton(); // ENHANCED VERSION
  console.log('UI initialization complete');
}

// ENHANCED: Completely rewritten chat button fix function
function fixChatButton() {
  console.log('Applying comprehensive chat button fix');
  const chatToggleBtn = document.getElementById('chat-toggle');
  const chatContainer = document.getElementById('chat-container');
  
  if (!chatToggleBtn || !chatContainer) {
    console.error('Could not find chat elements to fix');
    return;
  }
  
  console.log('Chat container initial state:', {
    hidden: chatContainer.classList.contains('hidden'),
    display: window.getComputedStyle(chatContainer).display,
    visibility: window.getComputedStyle(chatContainer).visibility,
    opacity: window.getComputedStyle(chatContainer).opacity
  });
  
  // Remove all existing click handlers by cloning the element
  const newChatToggleBtn = chatToggleBtn.cloneNode(true);
  chatToggleBtn.parentNode.replaceChild(newChatToggleBtn, chatToggleBtn);
  
  // Add fresh event listener with enhanced visibility handling
  newChatToggleBtn.addEventListener('click', function(e) {
    e.preventDefault();
    console.log('Chat toggle clicked - comprehensive handler');
    
    // Force the chat container to be visible and properly styled
    if (chatContainer.classList.contains('hidden')) {
      console.log('Showing chat container');
      chatContainer.classList.remove('hidden');
      newChatToggleBtn.classList.add('active');
      
      // ENHANCED: Force proper styling to ensure visibility
      chatContainer.style.display = 'flex';
      chatContainer.style.visibility = 'visible';
      chatContainer.style.opacity = '1';
      chatContainer.style.transform = 'none';
      chatContainer.style.pointerEvents = 'auto';
      chatContainer.style.zIndex = '99999';
      
      // Focus the input when opened
      setTimeout(() => {
        const input = document.getElementById('message-input');
        if (input) input.focus();
        
        // Log the state after showing
        console.log('Chat container shown state:', {
          hidden: chatContainer.classList.contains('hidden'),
          display: window.getComputedStyle(chatContainer).display,
          visibility: window.getComputedStyle(chatContainer).visibility,
          opacity: window.getComputedStyle(chatContainer).opacity,
          transform: window.getComputedStyle(chatContainer).transform
        });
      }, 100);
    } else {
      console.log('Hiding chat container');
      chatContainer.classList.add('hidden');
      newChatToggleBtn.classList.remove('active');
    }
  });
  
  // Also fix minimize button
  const minimizeBtn = document.getElementById('minimize-chat');
  if (minimizeBtn) {
    // Remove existing handlers
    const newMinimizeBtn = minimizeBtn.cloneNode(true);
    minimizeBtn.parentNode.replaceChild(newMinimizeBtn, minimizeBtn);
    
    // Add fresh handler
    newMinimizeBtn.addEventListener('click', function() {
      console.log('Minimize chat clicked');
      chatContainer.classList.add('hidden');
      newChatToggleBtn.classList.remove('active');
    });
  }
  
  // Add a test message to confirm chat is working
  const messagesContainer = document.getElementById('messages-container');
  if (messagesContainer) {
    const testMsg = document.createElement('div');
    testMsg.className = 'system-message';
    testMsg.textContent = 'Chat is now working! Click the chat icon (top-right) to toggle.';
    messagesContainer.appendChild(testMsg);
    
    // Auto-scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
  
  // ENHANCED: Add global toggle function for emergency access
  window.toggleNetflixTogetherChat = function() {
    console.log('EMERGENCY CHAT TOGGLE');
    if (chatContainer.classList.contains('hidden')) {
      chatContainer.classList.remove('hidden');
      chatContainer.style.display = 'flex';
      chatContainer.style.transform = 'none';
      chatContainer.style.opacity = '1';
      chatContainer.style.visibility = 'visible';
      chatContainer.style.pointerEvents = 'auto';
      chatContainer.style.zIndex = '99999';
      return 'Chat shown';
    } else {
      chatContainer.classList.add('hidden');
      return 'Chat hidden';
    }
  };
  
  console.log('Comprehensive chat button fix applied');
}

// NEW: Add emergency chat button function
function addEmergencyChatButton() {
  const emergencyBtn = document.createElement('button');
  emergencyBtn.textContent = "Show Chat";
  emergencyBtn.style = "position:fixed; top:250px; left:10px; z-index:99999; background:#e50914; color:white; border:none; padding:10px; border-radius:5px; cursor:pointer;";
  emergencyBtn.onclick = function() {
    const chatContainer = document.getElementById('chat-container');
    if (chatContainer) {
      if (chatContainer.classList.contains('hidden')) {
        chatContainer.classList.remove('hidden');
        chatContainer.style.display = 'flex';
        chatContainer.style.transform = 'none';
        chatContainer.style.opacity = '1';
        chatContainer.style.visibility = 'visible';
        chatContainer.style.zIndex = '99999';
        this.textContent = "Hide Chat";
      } else {
        chatContainer.classList.add('hidden');
        this.textContent = "Show Chat";
      }
    } else {
      console.error('Chat container not found');
      alert('Chat container not found. Please refresh the page.');
    }
  };
  document.body.appendChild(emergencyBtn);
}

function makeDraggable(element, handleElement) {
  if (!element) return;
  
  const handle = handleElement || element;
  let isDragging = false;
  let startX, startY, initialLeft, initialTop;

  // Initialize position if not already set
  if (!element.style.left && !element.style.right) {
    if (element.classList.contains('video-container')) {
      // Start video container at top right
      element.style.top = '60px';
      element.style.right = '10px';
      element.style.left = 'auto';
    } else if (element.classList.contains('chat-container')) {
      // Start chat at bottom right
      element.style.bottom = '10px';
      element.style.right = '10px';
      element.style.left = 'auto';
    }
  }
  
  handle.addEventListener('mousedown', startDrag);
  
  function startDrag(e) {
    // Prevent default to avoid text selection during drag
    e.preventDefault();
    
    // For chat header, we only want to drag when clicking the header itself, not its buttons
    if (handle.classList.contains('chat-header') && e.target.tagName === 'BUTTON') {
      return;
    }
    
    isDragging = true;
    
    // Get initial positions
    startX = e.clientX;
    startY = e.clientY;
    
    // Convert right/bottom positioning to left/top if needed
    if (element.style.right && element.style.right !== 'auto') {
      const rect = element.getBoundingClientRect();
      element.style.left = (window.innerWidth - rect.right) + 'px';
      element.style.right = 'auto';
    }
    
    if (element.style.bottom && element.style.bottom !== 'auto') {
      const rect = element.getBoundingClientRect();
      element.style.top = (window.innerHeight - rect.bottom) + 'px';
      element.style.bottom = 'auto';
    }
    
    initialLeft = element.style.left ? parseInt(element.style.left) : 0;
    initialTop = element.style.top ? parseInt(element.style.top) : 0;
    
    // Add dragging class
    element.classList.add('dragging');
    
    // Add event listeners for drag and end
    document.addEventListener('mousemove', doDrag);
    document.addEventListener('mouseup', stopDrag);
  }
  
  function doDrag(e) {
    if (!isDragging) return;
    
    // Calculate new position
    const newLeft = initialLeft + (e.clientX - startX);
    const newTop = initialTop + (e.clientY - startY);
    
    // Set new position
    element.style.left = newLeft + 'px';
    element.style.top = newTop + 'px';
  }
  
  function stopDrag() {
    if (!isDragging) return;
    
    isDragging = false;
    element.classList.remove('dragging');
    
    // Remove event listeners
    document.removeEventListener('mousemove', doDrag);
    document.removeEventListener('mouseup', stopDrag);
  }
}

// Setup for draggable elements
function setupDraggableElements() {
  console.log('Setting up draggable elements');
  
  // Make video container draggable
  const videoContainer = document.querySelector('.video-container');
  if (videoContainer) {
    makeDraggable(videoContainer);
  }
  
  // Make chat container draggable by its header
  const chatContainer = document.getElementById('chat-container');
  const chatHeader = document.querySelector('.chat-header');
  
  if (chatContainer && chatHeader) {
    makeDraggable(chatContainer, chatHeader);
  }
}

// Improved chat toggle functionality
function setupChatToggle() {
  const chatToggleBtn = document.getElementById('chat-toggle');
  const chatContainer = document.getElementById('chat-container');
  const minimizeBtn = document.getElementById('minimize-chat');
  
  if (!chatToggleBtn || !chatContainer) return;
  
  // Add active state tracking
  chatToggleBtn.addEventListener('click', () => {
    const isHidden = chatContainer.classList.contains('hidden');
    
    // Toggle the hidden class
    chatContainer.classList.toggle('hidden');
    
    // Toggle the active class on the button
    if (isHidden) {
      chatToggleBtn.classList.add('active');
      // Focus the input when opened
      setTimeout(() => {
        const input = document.getElementById('message-input');
        if (input) input.focus();
      }, 100);
    } else {
      chatToggleBtn.classList.remove('active');
    }
  });
  
  // Make minimize button work
  if (minimizeBtn) {
    minimizeBtn.addEventListener('click', () => {
      chatContainer.classList.add('hidden');
      chatToggleBtn.classList.remove('active');
    });
  }
  
  // Click outside to close (but not when clicking inside the chat)
  document.addEventListener('mousedown', (event) => {
    // Only proceed if chat is visible and click is outside
    if (!chatContainer.classList.contains('hidden') && 
        !chatContainer.contains(event.target) && 
        !chatToggleBtn.contains(event.target)) {
      chatContainer.classList.add('hidden');
      chatToggleBtn.classList.remove('active');
    }
  });
}

// Toggle button active states
function setupToggleButtonStates() {
  const micToggleBtn = document.getElementById('mic-toggle');
  const cameraToggleBtn = document.getElementById('camera-toggle');
  
  // Initialize mic button active state based on settings
  if (micToggleBtn) {
    chrome.storage.local.get('userSettings', (data) => {
      const settings = data.userSettings || {};
      if (settings.micEnabled !== false) {
        micToggleBtn.classList.add('active');
      }
    });
  }
  
  // Initialize camera button active state based on settings
  if (cameraToggleBtn) {
    chrome.storage.local.get('userSettings', (data) => {
      const settings = data.userSettings || {};
      if (settings.cameraEnabled !== false) {
        cameraToggleBtn.classList.add('active');
      }
    });
  }
}

// Add tooltip functionality
function setupTooltips() {
  const tooltip = document.getElementById('tooltip');
  if (!tooltip) return;
  
  const elements = document.querySelectorAll('[data-tooltip]');
  
  elements.forEach(el => {
    el.addEventListener('mouseenter', (e) => {
      const text = el.getAttribute('data-tooltip');
      tooltip.textContent = text;
      tooltip.style.opacity = 1;
      
      // Position tooltip
      const rect = el.getBoundingClientRect();
      tooltip.style.top = (rect.top - 30) + 'px';
      tooltip.style.left = (rect.left + rect.width/2 - tooltip.offsetWidth/2) + 'px';
    });
    
    el.addEventListener('mouseleave', () => {
      tooltip.style.opacity = 0;
    });
  });
}

// ENHANCED: Modified to prioritize the fixed chat button
function enhanceInitializeUI() {
  // Only call setupChatToggle() if we haven't fixed the chat button already
  if (!window.chatFixApplied) {
    fixChatButton();
    window.chatFixApplied = true;
  } else {
    console.log('Chat fix already applied, skipping setupChatToggle()');
  }
  
  setupToggleButtonStates();
  setupDraggableElements();
  setupTooltips();
  
  // Show a notification
  showNotification('You can drag the video and chat windows anywhere on the screen!');
}

// Helper function to show notifications
function showNotification(message) {
  const notification = document.createElement('div');
  notification.className = 'notification';
  notification.textContent = message;
  document.body.appendChild(notification);
  
  // Remove after animation (3 seconds)
  setTimeout(() => {
    notification.remove();
  }, 3000);
}

// Set up event listeners for communication from page script
function setupPageScriptEventListeners(roomCode, isHost) {
  console.log('Setting up page script event listeners for room', roomCode, 'isHost:', isHost);
  
  // Listen for page script loaded event
  document.addEventListener('netflix-together-page-script-loaded', function pageScriptLoadedHandler() {
    console.log('Page script loaded event received - STARTING MAIN CONNECTION');
    
    // Give the page script time to fully initialize
    setTimeout(() => {
      // Create connection via postMessage
      console.log('Sending connection request to page script');
      window.postMessage({
        type: 'NETFLIX_TOGETHER_CREATE_CONNECTION',
        serverUrl: 'https://netflix-together-server.onrender.com'
      }, '*');
    }, 1000);  // Wait 1 second to ensure page script is fully ready
    
    // Remove this listener to avoid duplicate handlers
    document.removeEventListener('netflix-together-page-script-loaded', pageScriptLoadedHandler);
  });
  
  // Listen for messages from page script
  window.addEventListener('message', function(event) {
    // Only accept messages from our window
    if (event.source !== window) return;
    
    const data = event.data;
    if (!data || !data.type || !data.type.startsWith('NETFLIX_TOGETHER_')) return;
    
    if (data.type === 'NETFLIX_TOGETHER_CONNECTION_CREATED') {
      console.log('Connection created response received:', data.success);
      
      if (data.success) {
        // CRITICAL: Store room info in window scope for emergency recovery
        window.currentRoomCode = roomCode;
        window.currentIsHost = isHost;
        
        console.log('Connection successful - joining room:', roomCode, 'isHost:', isHost);
        // Join room with explicit uppercase normalized room code
        window.postMessage({
          type: 'NETFLIX_TOGETHER_JOIN_ROOM',
          roomCode: roomCode.toUpperCase(),
          isHost: isHost
        }, '*');
        
        // Log that join request was sent
        console.log('Join room request sent for room:', roomCode.toUpperCase());
        
        // Double-check the room status after a few seconds
        setTimeout(() => {
          console.log('Verifying room status after delay', roomCode);
          window.postMessage({
            type: 'NETFLIX_TOGETHER_CHECK_ROOM',
            roomCode: roomCode
          }, '*');
        }, 5000);
      } else {
        console.error('Failed to create socket connection');
        addSystemMessage('Failed to create connection. Please try again.');
      }
    }
  });
  
  // Listen for socket connection events
  document.addEventListener('netflix-together-socket-connected', function() {
    console.log('Socket connected event received');
    addSystemMessage('Connected to server!');
    
    // CRITICAL FIX: Immediately try to join the room after connection
    setTimeout(() => {
      console.log('Socket connected, joining room:', roomCode, 'isHost:', isHost);
      window.postMessage({
        type: 'NETFLIX_TOGETHER_JOIN_ROOM',
        roomCode: roomCode.toUpperCase(),
        isHost: isHost
      }, '*');
      
      // Also expose roomCode in global scope for emergency recovery
      window.currentRoomCode = roomCode;
      window.currentIsHost = isHost;
      
      // Start ping interval to keep connection alive
      setInterval(() => {
        window.postMessage({
          type: 'NETFLIX_TOGETHER_PING'
        }, '*');
      }, 30000);
    }, 1000);
    
    // Request media permissions if not already requested
    if (!mediaPermissionsRequested) {
      requestMediaPermissions();
    }
  });
  
  // Explicitly check if join was successful
  document.addEventListener('netflix-together-joined-room', function(e) {
    console.log('Joined room event received:', e.detail);
    addSystemMessage(`Joined room ${e.detail.roomCode}. ${e.detail.usersCount > 1 ? 'Other users are in the room.' : 'Waiting for others to join...'}`);
    
    // CRITICAL FIX: Force check for partner after 3 seconds
    setTimeout(() => {
      console.log("Forcing partner check after delay");
      window.postMessage({
        type: 'NETFLIX_TOGETHER_CHECK_ROOM',
        roomCode: e.detail.roomCode
      }, '*');
    }, 3000);
  });
  
  document.addEventListener('netflix-together-socket-error', function(e) {
    console.error('Socket error event received:', e.detail.message);
    addSystemMessage(`Connection error: ${e.detail.message}`);
  });
  
  document.addEventListener('netflix-together-reconnecting', function(e) {
    console.log('Reconnecting, attempt:', e.detail.attempt);
    addSystemMessage(`Connection lost. Reconnecting... (Attempt ${e.detail.attempt})`);
  });
  
  document.addEventListener('netflix-together-reconnected', function(e) {
    console.log('Reconnected after', e.detail.attempts, 'attempts');
    addSystemMessage(`Reconnected to server!`);
    
    // Try to rejoin the room
    setTimeout(() => {
      window.postMessage({
        type: 'NETFLIX_TOGETHER_JOIN_ROOM',
        roomCode: roomCode.toUpperCase(),
        isHost: isHost
      }, '*');
    }, 1000);
  });
  
  document.addEventListener('netflix-together-disconnected', function(e) {
    console.log('Disconnected, reason:', e.detail.reason);
    addSystemMessage(`Disconnected from server. Reason: ${e.detail.reason}`);
  });
  
  document.addEventListener('netflix-together-user-joined', function(e) {
    console.log('User joined event received:', e.detail.userId);
    chrome.runtime.sendMessage({action: 'partnerConnected'}, (response) => {
      console.log('Partner connected response:', response);
    });
    addSystemMessage('Your partner joined the session!');
    
    // Add a class to track partner connection state
    document.body.classList.add('partner-connected');
    
    // Remove emergency button if it exists
    const recoveryButton = document.getElementById('netflix-together-recovery');
    if (recoveryButton) {
      recoveryButton.style.display = 'none';
    }
    
    // FIXED: If we are host, allow time for user's media to initialize
    if (currentIsHost === true) {
      console.log('Partner joined and we are host - will initiate connection shortly');
      offerCreated = false; // Reset this flag in case of reconnection
      waitingForRemoteDescription = false;
      
      setTimeout(() => {
        console.log("Starting WebRTC connection as host after short delay");
        if (!localStream) {
          console.log("Requesting media before creating WebRTC connection");
          requestMediaPermissions().then(() => {
            setupPeerConnection();
            createOffer();
          });
        } else {
          setupPeerConnection();
          createOffer();
        }
      }, 2000);
    } else {
      console.log('Partner joined but we are not host - waiting for offer');
      if (!localStream) {
        requestMediaPermissions().then(() => {
          setupPeerConnection();
        });
      } else {
        setupPeerConnection();
      }
    }
  });
  
  document.addEventListener('netflix-together-user-left', function(e) {
    console.log('User left event received:', e.detail.userId);
    chrome.runtime.sendMessage({action: 'partnerDisconnected'}, (response) => {
      console.log('Partner disconnected response:', response);
    });
    
    // Remove partner connection class
    document.body.classList.remove('partner-connected');
    
    // Reset remote video
    const remoteVideo = document.getElementById('remote-video');
    if (remoteVideo) {
      remoteVideo.srcObject = null;
    }
    
    // Reset WebRTC state flags
    offerCreated = false;
    waitingForRemoteDescription = false;
    pendingCandidates = [];
    
    addSystemMessage('Your partner left the session.');
  });
  
  document.addEventListener('netflix-together-signal-received', function(e) {
    console.log('Signal received event:', e.detail.type);
    handleSignalingData(e.detail);
  });
  
  document.addEventListener('netflix-together-chat-message-received', function(e) {
    console.log('Chat message received event:', e.detail);
    addChatMessage('Partner', e.detail.message);
  });
  
  document.addEventListener('netflix-together-video-control-received', function(e) {
    console.log('Video control received event:', e.detail);
    handleRemoteVideoControl(e.detail);
  });
}

function requestMediaPermissions() {
  console.log('Requesting media permissions...');
  addSystemMessage('Requesting camera and microphone access...');
  mediaPermissionsRequested = true;
  
  // Create a connection status indicator
  const statusIndicator = document.createElement('div');
  statusIndicator.className = 'connection-status';
  statusIndicator.innerHTML = '<div class="status-dot connecting"></div><span>Connecting to partner...</span>';
  statusIndicator.id = 'webrtc-status';
  document.body.appendChild(statusIndicator);
  
  // IMPORTANT: Set explicit constraints for better compatibility
  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: {
      width: { ideal: 320 },
      height: { ideal: 240 },
      frameRate: { max: 30 }
    }
  };
  
  console.log('Using media constraints:', JSON.stringify(constraints));
  
  // Return a promise for better chaining
  return new Promise((resolve, reject) => {
    navigator.mediaDevices.getUserMedia(constraints)
      .then(stream => {
        console.log('Media access granted! Tracks:', stream.getTracks().map(t => `${t.kind}:${t.id}`).join(', '));
        localStream = stream;
        
        // Display local video
        const localVideo = document.getElementById('local-video');
        if (localVideo) {
          console.log('Setting local video source');
          localVideo.srcObject = stream;
          
          // Verify the video shows correctly
          localVideo.oncanplay = () => {
            console.log('Local video can play - dimensions:', localVideo.videoWidth, 'x', localVideo.videoHeight);
          };
          
          // Ensure video is playing
          localVideo.play().catch(e => console.error('Error playing local video:', e));
        }
        
        resolve(stream);
      })
      .catch(error => {
        console.error('Media permission error:', error.name, error.message);
        
        // Update connection indicator
        const statusIndicator = document.getElementById('webrtc-status');
        if (statusIndicator) {
          statusIndicator.innerHTML = '<div class="status-dot disconnected"></div><span>Media error: ' + error.name + '</span>';
        }
        
        addSystemMessage(`Error: ${error.name} - ${error.message}`);
        
        // Try with just audio if video fails
        if (error.name === 'NotAllowedError' || error.name === 'NotFoundError') {
          console.log('Trying fallback: audio only');
          navigator.mediaDevices.getUserMedia({ audio: true, video: false })
            .then(audioStream => {
              console.log('Got audio-only stream');
              localStream = audioStream;
              
              // Display indicator in local video box
              const localVideo = document.getElementById('local-video');
              if (localVideo && localVideo.parentElement) {
                const noVideoIndicator = document.createElement('div');
                noVideoIndicator.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;color:#fff;';
                noVideoIndicator.innerHTML = '<span>Camera disabled</span>';
                localVideo.parentElement.appendChild(noVideoIndicator);
              }
              
              resolve(audioStream);
            })
            .catch(audioError => {
              console.error('Even audio-only failed:', audioError);
              addSystemMessage('Could not access your camera or microphone. Please check permissions.');
              reject(audioError);
            });
        } else {
          reject(error);
        }
      });
  });
}

function setupPeerConnection() {
  console.log('Setting up WebRTC peer connection');
  
  // IMPROVED: More reliable ICE server configuration
  const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      // Public turn servers as fallback
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ],
    iceCandidatePoolSize: 10
  };
  
  try {
    // Close any existing connection
    if (peerConnection) {
      console.log('Closing existing peer connection');
      peerConnection.close();
      peerConnection = null;
    }
    
    // Reset state flags
    offerCreated = false;
    waitingForRemoteDescription = false;
    pendingCandidates = [];
    
    console.log('Creating new RTCPeerConnection');
    peerConnection = new RTCPeerConnection(configuration);
    
    // Make peerConnection available globally for debugging
    window.peerConnection = peerConnection;
    
    // Comprehensive event logging
    peerConnection.addEventListener('negotiationneeded', () => {
      console.log('🔄 Negotiation needed event - may need to create offer');
      
      // Only create an offer if we're the host and haven't already created one
      if (currentIsHost === true && !offerCreated && peerConnection.signalingState === 'stable') {
        console.log('Creating offer due to negotiationneeded event');
        setTimeout(createOffer, 500);
      } else {
        console.log('Not creating offer: isHost=', currentIsHost, 
                   'offerCreated=', offerCreated, 
                   'signalingState=', peerConnection.signalingState);
      }
    });
    
    peerConnection.addEventListener('icecandidateerror', (event) => {
      console.warn('❌ ICE Candidate Error:', event.errorText);
    });
    
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('Generated ICE candidate for:', event.candidate.sdpMid);
        
        // FIXED: Don't send the RTCIceCandidate object directly!
        // Instead, extract its serializable properties
        const candidateObj = {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment
        };
        
        // Don't send if we don't have a remote description yet
        if (waitingForRemoteDescription) {
          console.log('Adding ICE candidate to pending queue (waiting for remote description)');
          pendingCandidates.push(candidateObj);
          return;
        }
        
        // Send serialized candidate
        window.postMessage({
          type: 'NETFLIX_TOGETHER_SIGNAL',
          signal: {
            type: 'ice-candidate',
            candidate: candidateObj
          }
        }, '*');
      } else {
        console.log('ICE candidate gathering complete');
      }
    };
    
    peerConnection.oniceconnectionstatechange = () => {
      const state = peerConnection.iceConnectionState;
      console.log(`ICE connection state changed to: ${state}`);
      
      // Update connection status indicator
      const statusIndicator = document.getElementById('webrtc-status');
      if (statusIndicator) {
        if (state === 'connected' || state === 'completed') {
          statusIndicator.innerHTML = '<div class="status-dot connected"></div><span>Connected to partner</span>';
        } else if (state === 'failed' || state === 'disconnected') {
          statusIndicator.innerHTML = '<div class="status-dot disconnected"></div><span>Connection issue</span>';
        } else {
          statusIndicator.innerHTML = '<div class="status-dot connecting"></div><span>Connecting...</span>';
        }
      }
      
      if (state === 'failed') {
        console.log('ICE connection failed, attempting recovery');
        
        // Reset flags and restart ICE
        offerCreated = false;
        waitingForRemoteDescription = false;
        peerConnection.restartIce();
        
        // If we're the host, try to create a new offer after ICE restart
        if (currentIsHost === true) {
          setTimeout(() => {
            createOffer();
          }, 2000);
        }
      }
    };
    
    peerConnection.onicegatheringstatechange = () => {
      console.log(`ICE gathering state: ${peerConnection.iceGatheringState}`);
    };
    
    peerConnection.onsignalingstatechange = () => {
      console.log(`Signaling state: ${peerConnection.signalingState}`);
      
      // If we transition back to 'stable', we can process any pending candidates
      if (peerConnection.signalingState === 'stable' && waitingForRemoteDescription) {
        waitingForRemoteDescription = false;
        
        // Process any pending ICE candidates
        if (pendingCandidates.length > 0) {
          console.log(`Processing ${pendingCandidates.length} pending ICE candidates`);
          
          pendingCandidates.forEach(candidate => {
            window.postMessage({
              type: 'NETFLIX_TOGETHER_SIGNAL',
              signal: {
                type: 'ice-candidate',
                candidate: candidate
              }
            }, '*');
          });
          
          pendingCandidates = [];
        }
      }
    };
    
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      console.log(`Connection state changed to: ${state}`);
      
      switch(state) {
        case 'connected':
          addSystemMessage('Video connection established!');
          break;
        case 'disconnected':
          addSystemMessage('Connection with partner lost. Waiting for reconnection...');
          break;
        case 'failed':
          addSystemMessage('Connection failed. Attempting to reconnect...');
          offerCreated = false;
          waitingForRemoteDescription = false;
          
          // Only the host tries to reconnect to avoid conflicts
          if (currentIsHost === true) {
            setTimeout(() => {
              console.log('Host is trying to recreate connection after failure');
              setupPeerConnection();
            }, 3000);
          }
          break;
      }
    };
    
    // FIXED: Improved ontrack handling
    peerConnection.ontrack = (event) => {
      console.log(`Received remote ${event.track.kind} track`);
      
      // Create a media stream if we don't have one already
      if (!remoteStream) {
        remoteStream = new MediaStream();
      }
      
      // Add the track to our remoteStream
      remoteStream.addTrack(event.track);
      
      // Handle the remote video element
      const remoteVideo = document.getElementById('remote-video');
      if (remoteVideo) {
        console.log('Setting remote video element source');
        remoteVideo.srcObject = remoteStream;
        
        // Force the remote video to play automatically
        remoteVideo.muted = false;
        remoteVideo.setAttribute('playsinline', '');
        remoteVideo.setAttribute('autoplay', '');
        
        // Try to play the video
        remoteVideo.play().catch(error => {
          console.error('Remote video autoplay error:', error);
          // Show an indicator to the user
          addSystemMessage('Click anywhere to enable partner\'s video');
          
          // Add a click handler to retry playback
          document.body.addEventListener('click', () => {
            remoteVideo.play()
              .then(() => console.log('Remote video playing after user interaction'))
              .catch(e => console.error('Still cannot play video:', e));
          }, { once: true });
        });
      } else {
        console.error('Remote video element not found!');
      }
      
      // Update message based on track type
      if (event.track.kind === 'video') {
        addSystemMessage('Partner\'s camera connected!');
      } else if (event.track.kind === 'audio') {
        addSystemMessage('Partner\'s microphone connected!');
      }
    };
    
    // Add data channel for chat
    try {
      const dataChannel = peerConnection.createDataChannel('chat', {
        ordered: true
      });
      
      dataChannel.onopen = () => {
        console.log('Data channel opened');
      };
      
      dataChannel.onclose = () => {
        console.log('Data channel closed');
      };
      
      dataChannel.onmessage = (event) => {
        console.log('Data channel message:', event.data);
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'chat') {
            addChatMessage('Partner', data.message);
          }
        } catch (e) {
          console.log('Error parsing data channel message:', e);
        }
      };
      
      // Store the data channel
      window.chatDataChannel = dataChannel;
      
    } catch (e) {
      console.log('Could not create data channel:', e.message);
    }
    
    // Add local media tracks to the peer connection
    if (localStream) {
      console.log(`Adding ${localStream.getTracks().length} local tracks to peer connection`);
      
      localStream.getTracks().forEach(track => {
        try {
          peerConnection.addTrack(track, localStream);
        } catch (err) {
          console.error(`Error adding ${track.kind} track:`, err);
        }
      });
    } else {
      console.log('No local stream available yet');
    }
    
    console.log('Peer connection setup complete');
    return peerConnection;
  } catch (error) {
    console.error('Error in setupPeerConnection:', error);
    addSystemMessage(`Error setting up connection: ${error.message}`);
    return null;
  }
}

function createOffer() {
  console.log('Starting to create WebRTC offer...');
  
  if (!peerConnection) {
    console.error('Cannot create offer: no peer connection exists');
    return;
  }
  
  // FIXED: Check signaling state before creating offer
  if (peerConnection.signalingState !== 'stable') {
    console.warn(`Cannot create offer in '${peerConnection.signalingState}' state, waiting for stable state`);
    return;
  }
  
  if (offerCreated) {
    console.log('Offer already created, skipping');
    return;
  }
  
  // Set flag to prevent multiple offers
  offerCreated = true;
  
  // FIXED: Better offer options
  const offerOptions = {
    offerToReceiveAudio: true,
    offerToReceiveVideo: true
  };
  
  peerConnection.createOffer(offerOptions)
    .then(offer => {
      console.log('Offer created');
      
      // Set local description
      return peerConnection.setLocalDescription(offer);
    })
    .then(() => {
      console.log('Local description set as offer');
      
      // We need to wait for ICE gathering
      waitingForRemoteDescription = true;
      
      // FIXED: Don't send the RTCSessionDescription object directly!
      // Instead, extract its serializable properties
      setTimeout(() => {
        // Create a serializable version of the session description
        const sdpObj = {
          type: peerConnection.localDescription.type,
          sdp: peerConnection.localDescription.sdp
        };
        
        console.log('Sending offer to remote peer');
        
        window.postMessage({
          type: 'NETFLIX_TOGETHER_SIGNAL',
          signal: {
            type: 'offer',
            sdp: sdpObj
          }
        }, '*');
      }, 1000);
    })
    .catch(error => {
      console.error('Error creating offer:', error);
      offerCreated = false; // Reset the flag to allow retrying
      addSystemMessage(`Connection error: ${error.message}`);
    });
}

function createAnswer(offerSdp) {
  console.log('Creating answer...');
  
  if (!peerConnection) {
    console.error('Cannot create answer: no peer connection exists');
    return Promise.reject(new Error('No peer connection'));
  }
  
  // Convert the SDP object to an RTCSessionDescription
  const offerDesc = new RTCSessionDescription(offerSdp);
  
  // Set remote description
  return peerConnection.setRemoteDescription(offerDesc)
    .then(() => {
      console.log('Remote description set from offer');
      waitingForRemoteDescription = false;
      
      // Process any pending candidates
      if (pendingCandidates.length > 0) {
        console.log(`Processing ${pendingCandidates.length} pending ICE candidates after setting remote description`);
        
        pendingCandidates.forEach(candidate => {
          const iceCandidate = new RTCIceCandidate(candidate);
          peerConnection.addIceCandidate(iceCandidate)
            .catch(err => console.error('Error adding pending ICE candidate:', err));
        });
        
        pendingCandidates = [];
      }
      
      // Create answer
      return peerConnection.createAnswer();
    })
    .then(answer => {
      console.log('Answer created');
      return peerConnection.setLocalDescription(answer);
    })
    .then(() => {
      console.log('Local description set as answer');
      
      // FIXED: Create a serializable version of the session description
      const sdpObj = {
        type: peerConnection.localDescription.type,
        sdp: peerConnection.localDescription.sdp
      };
      
      window.postMessage({
        type: 'NETFLIX_TOGETHER_SIGNAL',
        signal: {
          type: 'answer',
          sdp: sdpObj
        }
      }, '*');
    })
    .catch(error => {
      console.error('Error in answer creation process:', error);
      waitingForRemoteDescription = false;
      throw error;
    });
}

function handleSignalingData(data) {
  if (!data) {
    console.error('Received empty signaling data');
    return;
  }
  
  console.log(`Received ${data.type} signal`);
  
  if (!peerConnection) {
    console.error('Cannot handle signaling: no peer connection exists');
    console.log('Setting up peer connection first...');
    setupPeerConnection();
  }
  
  try {
    if (data.type === 'offer') {
      console.log('Received offer');
      
      // Create answer using the received offer
      createAnswer(data.sdp)
        .catch(error => {
          console.error('Error handling offer:', error);
          addSystemMessage(`Connection error: ${error.message}`);
        });
    }
    
    else if (data.type === 'answer') {
      console.log('Received answer');
      
      // Create an RTCSessionDescription from the serialized data
      const answerDesc = new RTCSessionDescription(data.sdp);
      
      peerConnection.setRemoteDescription(answerDesc)
        .then(() => {
          console.log('Remote description set from answer');
          waitingForRemoteDescription = false;
          
          // Process any pending ICE candidates
          if (pendingCandidates.length > 0) {
            console.log(`Processing ${pendingCandidates.length} pending ICE candidates after setting remote description`);
            
            pendingCandidates.forEach(candidate => {
              const iceCandidate = new RTCIceCandidate(candidate);
              peerConnection.addIceCandidate(iceCandidate)
                .catch(err => console.error('Error adding pending ICE candidate:', err));
            });
            
            pendingCandidates = [];
          }
        })
        .catch(error => {
          console.error('Error setting remote description from answer:', error);
          addSystemMessage(`Connection error: ${error.message}`);
        });
    }
    
    else if (data.type === 'ice-candidate') {
      if (!data.candidate) {
        console.log('Received empty ICE candidate, ignoring');
        return;
      }
      
      console.log('Received ICE candidate');
      
      // Check if we can add the candidate now
      if (peerConnection.remoteDescription && !waitingForRemoteDescription) {
        try {
          // Create an RTCIceCandidate from the serialized data
          const candidate = new RTCIceCandidate(data.candidate);
          
          peerConnection.addIceCandidate(candidate)
            .then(() => {
              console.log('Added remote ICE candidate');
            })
            .catch(error => {
              console.error('Error adding ICE candidate:', error);
            });
        } catch (e) {
          console.error('Error creating ICE candidate object:', e);
        }
      } else {
        // Store the candidate for later
        console.log('Remote description not set yet, storing ICE candidate for later');
        pendingCandidates.push(data.candidate);
      }
    }
  } catch (error) {
    console.error('Error in signaling handler:', error);
    addSystemMessage(`Connection error: ${error.message}`);
  }
}

// Media Control Functions
function toggleMicrophone() {
  if (!localStream) {
    console.error('Cannot toggle microphone: no local stream');
    addSystemMessage('Cannot toggle microphone: no camera/microphone access');
    return;
  }
  
  const micToggleBtn = document.getElementById('mic-toggle');
  const audioTracks = localStream.getAudioTracks();
  
  if (audioTracks.length > 0) {
    const enabled = !audioTracks[0].enabled;
    audioTracks[0].enabled = enabled;
    
    console.log('Microphone ' + (enabled ? 'enabled' : 'disabled'));
    
    if (micToggleBtn) {
      micToggleBtn.innerHTML = enabled 
        ? '<i class="fas fa-microphone"></i>' 
        : '<i class="fas fa-microphone-slash"></i>';
      
      // Toggle active state
      micToggleBtn.classList.toggle('active', enabled);
    }
    
    // Update settings
    chrome.storage.local.get('userSettings', (data) => {
      const settings = data.userSettings || {};
      settings.micEnabled = enabled;
      chrome.storage.local.set({userSettings: settings});
    });
    
    addSystemMessage(`Microphone ${enabled ? 'enabled' : 'disabled'}`);
  }
}

function toggleCamera() {
  if (!localStream) {
    console.error('Cannot toggle camera: no local stream');
    addSystemMessage('Cannot toggle camera: no camera/microphone access');
    return;
  }
  
  const cameraToggleBtn = document.getElementById('camera-toggle');
  const videoTracks = localStream.getVideoTracks();
  
  if (videoTracks.length > 0) {
    const enabled = !videoTracks[0].enabled;
    videoTracks[0].enabled = enabled;
    
    console.log('Camera ' + (enabled ? 'enabled' : 'disabled'));
    
    if (cameraToggleBtn) {
      cameraToggleBtn.innerHTML = enabled 
        ? '<i class="fas fa-video"></i>' 
        : '<i class="fas fa-video-slash"></i>';
      
      // Toggle active state
      cameraToggleBtn.classList.toggle('active', enabled);
    }
    
    // Update camera indicator in local video
    const localVideo = document.getElementById('local-video');
    if (localVideo) {
      const cameraOffIndicator = document.getElementById('local-camera-off') || document.createElement('div');
      cameraOffIndicator.id = 'local-camera-off';
      cameraOffIndicator.className = 'camera-off-indicator';
      cameraOffIndicator.innerHTML = '<i class="fas fa-video-slash"></i>';
      
      if (!enabled) {
        localVideo.parentNode.appendChild(cameraOffIndicator);
      } else if (cameraOffIndicator.parentNode) {
        cameraOffIndicator.parentNode.removeChild(cameraOffIndicator);
      }
    }
    
    // Update settings
    chrome.storage.local.get('userSettings', (data) => {
      const settings = data.userSettings || {};
      settings.cameraEnabled = enabled;
      chrome.storage.local.set({userSettings: settings});
    });
    
    addSystemMessage(`Camera ${enabled ? 'enabled' : 'disabled'}`);
  }
}

// Chat Functions
function sendChatMessage() {
  const messageInput = document.getElementById('message-input');
  if (!messageInput || !messageInput.value.trim()) return;
  
  const message = messageInput.value.trim();
  messageInput.value = '';
  
  console.log('Sending chat message:', message);
  
  // Try to send via data channel first if available
  if (window.chatDataChannel && window.chatDataChannel.readyState === 'open') {
    try {
      window.chatDataChannel.send(JSON.stringify({
        type: 'chat',
        message: message
      }));
    } catch (e) {
      console.error('Error sending via data channel:', e);
      // Fall back to signaling
      window.postMessage({
        type: 'NETFLIX_TOGETHER_CHAT_MESSAGE',
        message: message
      }, '*');
    }
  } else {
    // Send message to partner via page script
    window.postMessage({
      type: 'NETFLIX_TOGETHER_CHAT_MESSAGE',
      message: message
    }, '*');
  }
  
  // Add to local chat
  addChatMessage('You', message);
}

function addChatMessage(sender, message) {
  const messagesContainer = document.getElementById('messages-container');
  if (!messagesContainer) return;
  
  const messageElement = document.createElement('div');
  messageElement.className = `chat-message ${sender === 'You' ? 'own-message' : 'partner-message'}`;
  
  const senderElement = document.createElement('div');
  senderElement.className = 'message-sender';
  senderElement.textContent = sender;
  
  const contentElement = document.createElement('div');
  contentElement.className = 'message-content';
  contentElement.textContent = message;
  
  const timeElement = document.createElement('div');
  timeElement.className = 'message-time';
  const now = new Date();
  timeElement.textContent = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  
  messageElement.appendChild(senderElement);
  messageElement.appendChild(contentElement);
  messageElement.appendChild(timeElement);
  
  messagesContainer.appendChild(messageElement);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function addSystemMessage(message) {
  const messagesContainer = document.getElementById('messages-container');
  if (!messagesContainer) {
    // If messages container doesn't exist yet, queue message to be displayed later
    console.log('System message (queued):', message);
    setTimeout(() => addSystemMessage(message), 1000);
    return;
  }
  
  console.log('System message:', message);
  
  const messageElement = document.createElement('div');
  messageElement.className = 'system-message';
  messageElement.textContent = message;
  
  messagesContainer.appendChild(messageElement);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Video Synchronization Functions
function setupVideoSync() {
  if (!videoElement) {
    console.error('Cannot set up video sync: no video element');
    return;
  }
  
  console.log('Setting up video synchronization');
  
  // Store initial state
  lastKnownTime = videoElement.currentTime;
  lastKnownPlaybackState = !videoElement.paused;
  
  // Add event listeners
  videoElement.addEventListener('play', handleVideoPlay);
  videoElement.addEventListener('pause', handleVideoPause);
  videoElement.addEventListener('seeking', handleVideoSeeking);
  
  // Periodic sync (every 5 seconds)
  videoSyncInterval = setInterval(() => {
    if (!videoElement) return;
    
    if (Math.abs(videoElement.currentTime - lastKnownTime) > 0.5) {
      // Time has changed significantly without seeking event, sync
      handleVideoSeeking();
    }
    
    // Update last known time
    lastKnownTime = videoElement.currentTime;
  }, 5000);
  
  console.log('Video synchronization set up complete');
}

function handleVideoPlay() {
  if (!videoElement) return;
  
  // Only send if state actually changed
  if (lastKnownPlaybackState !== true) {
    lastKnownPlaybackState = true;
    
    console.log('Video played, syncing with partner');
    
    // Send play command to partner via page script
    window.postMessage({
      type: 'NETFLIX_TOGETHER_VIDEO_CONTROL',
      action: 'play',
      time: videoElement.currentTime
    }, '*');
  }
}

function handleVideoPause() {
  if (!videoElement) return;
  
  // Only send if state actually changed
  if (lastKnownPlaybackState !== false) {
    lastKnownPlaybackState = false;
    
    console.log('Video paused, syncing with partner');
    
    // Send pause command to partner via page script
    window.postMessage({
      type: 'NETFLIX_TOGETHER_VIDEO_CONTROL',
      action: 'pause',
      time: videoElement.currentTime
    }, '*');
  }
}

window.debugWebRTC = function() {
  console.log("===== WEBRTC DEBUG REPORT =====");
  
  if (!peerConnection) {
    console.log("❌ No peer connection exists yet");
    return "No peer connection exists";
  }
  
  console.log("--- CONNECTION STATE ---");
  console.log("Connection State:", peerConnection.connectionState);
  console.log("ICE Connection State:", peerConnection.iceConnectionState);
  console.log("ICE Gathering State:", peerConnection.iceGatheringState);
  console.log("Signaling State:", peerConnection.signalingState);
  
  console.log("--- MEDIA STREAMS ---");
  console.log("Local Stream:", localStream ? 
    `Exists with tracks: ${localStream.getTracks().map(t => `${t.kind} (${t.readyState})`).join(', ')}` : 
    "Not available");
  
  console.log("Remote Stream:", remoteStream ? 
    `Exists with tracks: ${remoteStream.getTracks().map(t => `${t.kind} (${t.readyState})`).join(', ')}` : 
    "Not available");
  
  const localVideo = document.getElementById('local-video');
  if (localVideo && localVideo.srcObject) {
    console.log("Local video element has srcObject:", 
               localVideo.srcObject.getTracks().map(t => t.kind).join(', '), 
               "- Dimensions:", localVideo.videoWidth, "x", localVideo.videoHeight);
  } else {
    console.log("Local video element has no srcObject");
  }
  
  const remoteVideo = document.getElementById('remote-video');
  if (remoteVideo && remoteVideo.srcObject) {
    console.log("Remote video element has srcObject:", 
               remoteVideo.srcObject.getTracks().map(t => t.kind).join(', '), 
               "- Dimensions:", remoteVideo.videoWidth, "x", remoteVideo.videoHeight);
  } else {
    console.log("Remote video element has no srcObject");
  }
  
  console.log("--- TRANSCEIVER DETAILS ---");
  if (peerConnection.getTransceivers) {
    const transceivers = peerConnection.getTransceivers();
    console.log(`Found ${transceivers.length} transceivers:`);
    transceivers.forEach((t, i) => {
      console.log(`Transceiver #${i}:`);
      console.log(`  Mid: ${t.mid} / Direction: ${t.direction}`);
      console.log(`  Current Direction: ${t.currentDirection}`);
      console.log(`  Stopped: ${t.stopped}`);
      
      if (t.sender && t.sender.track) {
        console.log(`  Sender: ${t.sender.track.kind} track (${t.sender.track.readyState})`);
      } else {
        console.log("  No sender track");
      }
      
      if (t.receiver && t.receiver.track) {
        console.log(`  Receiver: ${t.receiver.track.kind} track (${t.receiver.track.readyState})`);
      } else {
        console.log("  No receiver track");
      }
    });
  }
  
  console.log("--- INTERNAL STATE ---");
  console.log("Current Role: " + (currentIsHost ? "Host" : "Guest"));
  console.log("Current Room: " + currentRoomCode);
  console.log("Offer Created: " + offerCreated);
  console.log("Waiting For Remote Description: " + waitingForRemoteDescription);
  console.log("Pending ICE Candidates: " + pendingCandidates.length);
  
  console.log("--- NETWORK CONFIG ---");
  const config = peerConnection.getConfiguration();
  console.log("ICE Servers:", config.iceServers ? config.iceServers.length : 0);
  if (config.iceServers) {
    config.iceServers.forEach((server, i) => {
      console.log(`  Server #${i}:`, server.urls);
    });
  }
  
  console.log("===== END DEBUG REPORT =====");
  
  return "WebRTC debug info logged to console";
};

// Additional helper functions for recovery
window.forceNewOffer = function() {
  console.log('🔄 Forcing new WebRTC offer...');
  
  // Reset state flags
  offerCreated = false;
  waitingForRemoteDescription = false;
  pendingCandidates = [];
  
  if (!peerConnection) {
    console.log('Creating peer connection first');
    setupPeerConnection();
    
    // If we have local media, set it up and create an offer
    if (localStream) {
      setTimeout(createOffer, 1000);
      return "Created new peer connection, creating offer...";
    } else {
      console.log('No local media, requesting first');
      requestMediaPermissions().then(() => {
        setupPeerConnection();
        setTimeout(createOffer, 1000);
      });
      return "Requesting media and setting up new connection...";
    }
  }
  
  // If connection is in an unstable state, recreate it
  if (peerConnection.signalingState !== 'stable') {
    console.log('Connection in unstable state, recreating');
    peerConnection.close();
    setupPeerConnection();
    setTimeout(createOffer, 1000);
    return "Recreated peer connection, creating offer...";
  }
  
  // Otherwise just create a new offer
  createOffer();
  return "Creating new offer";
};

window.restartMedia = function() {
  console.log('🔄 Restarting media...');
  
  // Stop any existing tracks
  if (localStream) {
    localStream.getTracks().forEach(track => {
      track.stop();
    });
    localStream = null;
  }
  
  // Request fresh media
  requestMediaPermissions()
    .then(stream => {
      console.log('Got new media stream');
      
      // Update the peer connection with new tracks if needed
      if (peerConnection) {
        const senders = peerConnection.getSenders();
        
        // Replace each track in the peer connection
        stream.getTracks().forEach(track => {
          const sender = senders.find(s => s.track && s.track.kind === track.kind);
          if (sender) {
            console.log(`Replacing ${track.kind} track in existing sender`);
            sender.replaceTrack(track);
          } else {
            console.log(`Adding new ${track.kind} track to connection`);
            peerConnection.addTrack(track, stream);
          }
        });
        
        // If we're the host, create a new offer after changing tracks
        if (currentIsHost === true) {
          offerCreated = false;
          setTimeout(createOffer, 1000);
        }
      }
    });
  
  return "Restarting media permissions";
};

// Full connection reset function
window.resetFullConnection = function() {
  console.log("🔄 Performing full connection reset");
  
  // Stop all media
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  // Close peer connection
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  // Reset all state
  offerCreated = false;
  waitingForRemoteDescription = false;
  pendingCandidates = [];
  remoteStream = null;
  
  // Clear remote video
  const remoteVideo = document.getElementById('remote-video');
  if (remoteVideo) {
    remoteVideo.srcObject = null;
  }
  
  // Create new media and connection
  return requestMediaPermissions()
    .then(() => {
      setupPeerConnection();
      
      // Create offer if we're the host
      if (currentIsHost === true) {
        setTimeout(createOffer, 1000);
      }
      
      return "Full connection reset complete";
    })
    .catch(error => {
      return "Reset failed: " + error.message;
    });
};

function handleVideoSeeking() {
  if (!videoElement) return;
  
  // Update last known time
  lastKnownTime = videoElement.currentTime;
  
  console.log('Video seeked to', videoElement.currentTime, 'syncing with partner');
  
  // Send seek command to partner via page script
  window.postMessage({
    type: 'NETFLIX_TOGETHER_VIDEO_CONTROL',
    action: 'seek',
    time: videoElement.currentTime
  }, '*');
}

function handleRemoteVideoControl(data) {
  if (!videoElement || ignoreNextTimeUpdate) return;
  
  // Set flag to ignore our own events that would be triggered by these changes
  ignoreNextTimeUpdate = true;
  
  if (data.action === 'play') {
    console.log('Remote play command received at time', data.time);
    
    // Set time if it's more than 0.5 seconds off
    if (Math.abs(videoElement.currentTime - data.time) > 0.5) {
      console.log('Adjusting time from', videoElement.currentTime, 'to', data.time);
      videoElement.currentTime = data.time;
    }
    
    // Play the video
    const playPromise = videoElement.play();
    if (playPromise) {
      playPromise.catch(error => {
        console.error('Error playing video:', error);
        // Many sites block autoplay, so we'll show a notification
        addSystemMessage('Autoplay blocked. Click play to sync with partner.');
      });
    }
    
    lastKnownPlaybackState = true;
  }
  
  else if (data.action === 'pause') {
    console.log('Remote pause command received at time', data.time);
    
    videoElement.pause();
    
    // Set time if it's more than 0.5 seconds off
    if (Math.abs(videoElement.currentTime - data.time) > 0.5) {
      console.log('Adjusting time from', videoElement.currentTime, 'to', data.time);
      videoElement.currentTime = data.time;
    }
    
    lastKnownPlaybackState = false;
  }
  
  else if (data.action === 'seek') {
    console.log('Remote seek command received to time', data.time);
    
    videoElement.currentTime = data.time;
    lastKnownTime = data.time;
  }
  
  // Reset flag after a short delay
  setTimeout(() => {
    ignoreNextTimeUpdate = false;
  }, 50);
}

function addFixButton() {
  const fixButton = document.createElement('button');
  fixButton.textContent = "Fix Video Call";
  fixButton.style = "position:fixed; top:130px; left:10px; z-index:10001; background:#e50914; color:white; border:none; padding:10px; border-radius:5px; cursor:pointer;";
  fixButton.onclick = function() {
    window.forceNewOffer();
  };
  document.body.appendChild(fixButton);
  
  // Add a full reset button too
  const resetButton = document.createElement('button');
  resetButton.textContent = "Full Reset";
  resetButton.style = "position:fixed; top:170px; left:10px; z-index:10001; background:#e50914; color:white; border:none; padding:10px; border-radius:5px; cursor:pointer;";
  resetButton.onclick = function() {
    window.resetFullConnection();
  };
  document.body.appendChild(resetButton);
}

// Add diagnostics and fix buttons
function addDiagnosticsAndFixButtons() {
  // Add the fix button
  addFixButton();
  
  // Make the debug button visible and functional
  const debugButton = document.getElementById('netflix-together-debug');
  if (debugButton) {
    debugButton.style.display = 'block';
    debugButton.addEventListener('click', () => {
      window.debugWebRTC();
    });
  }
}