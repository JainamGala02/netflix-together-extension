// background.js - Fixed version with proper async handling
// Handles the extension's background processes
chrome.runtime.onInstalled.addListener(() => {
  console.log('Netflix Together extension installed');
  
  // Initialize extension state
  chrome.storage.local.set({
    sessionActive: false,
    partnerConnected: false,
    roomCode: '',
    userSettings: {
      username: 'You',
      micEnabled: true,
      cameraEnabled: true,
      pictureInPicture: true
    }
  });
});

// Listen for messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Background received message:', message.action);
  
  if (message.action === "getState") {
    // FIXED: Don't use async pattern here, just get and respond
    chrome.storage.local.get(null, (data) => {
      console.log('Sending state data');
      sendResponse(data);
    });
    return true; // Keep channel open for async response
  }
  
  if (message.action === "startSession") {
    // Generate a room code if none provided
    const roomCode = message.roomCode || generateRoomCode();
    
    // FIXED: Use async callback properly
    chrome.storage.local.set({
      sessionActive: true,
      roomCode: roomCode
    }, () => {
      // Notify active tabs to inject the overlay
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (!tabs || tabs.length === 0) {
          console.error('No active tab found');
          sendResponse({success: false, message: "No active tab found."});
          return;
        }
        
        const activeTab = tabs[0];
        if (activeTab && isStreamingService(activeTab.url)) {
          // FIXED: Use a separate try/catch for the sendMessage call
          try {
            chrome.tabs.sendMessage(activeTab.id, {
              action: "injectOverlay",
              roomCode: roomCode,
              isHost: true  // Explicitly set isHost to true
            }, (response) => {
              console.log('Content script response:', response);
              // Forward response to original caller
              sendResponse({success: true, roomCode: roomCode});
            });
          } catch (err) {
            console.error('Error sending message to tab:', err);
            sendResponse({success: false, message: "Error communicating with content script."});
          }
        } else {
          sendResponse({success: false, message: "Please navigate to a supported streaming service."});
        }
      });
    });
    
    return true; // Keep message channel open for async response
  }
  
  if (message.action === "joinSession") {
    // FIXED: Use async callback properly
    chrome.storage.local.set({
      sessionActive: true,
      roomCode: message.roomCode
    }, () => {
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (!tabs || tabs.length === 0) {
          console.error('No active tab found');
          sendResponse({success: false, message: "No active tab found."});
          return;
        }
        
        const activeTab = tabs[0];
        if (activeTab && isStreamingService(activeTab.url)) {
          // FIXED: Use a separate try/catch for the sendMessage call
          try {
            chrome.tabs.sendMessage(activeTab.id, {
              action: "injectOverlay",
              roomCode: message.roomCode,
              isHost: false  // Explicitly set isHost to false
            }, (response) => {
              console.log('Content script response:', response);
              // Forward response to original caller
              sendResponse({success: true});
            });
          } catch (err) {
            console.error('Error sending message to tab:', err);
            sendResponse({success: false, message: "Error communicating with content script."});
          }
        } else {
          sendResponse({success: false, message: "Please navigate to a supported streaming service."});
        }
      });
    });
    
    return true; // Keep message channel open for async response
  }
  
  if (message.action === "endSession") {
    // FIXED: Use async callback properly
    chrome.storage.local.set({
      sessionActive: false,
      partnerConnected: false,
      roomCode: ''
    }, () => {
      // Notify active tabs to remove the overlay
      chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (tabs && tabs.length > 0) {
          try {
            chrome.tabs.sendMessage(tabs[0].id, {
              action: "removeOverlay"
            }, (response) => {
              console.log('Remove overlay response:', response);
              sendResponse({success: true});
            });
          } catch (err) {
            console.error('Error sending removeOverlay message:', err);
            // Still consider this successful since we've updated the state
            sendResponse({success: true});
          }
        } else {
          // No active tab, but we've updated the state
          sendResponse({success: true});
        }
      });
    });
    
    return true; // Keep message channel open for async response
  }
  
  if (message.action === "updateSettings") {
    chrome.storage.local.get("userSettings", (data) => {
      const updatedSettings = {...data.userSettings, ...message.settings};
      chrome.storage.local.set({userSettings: updatedSettings}, () => {
        sendResponse({success: true, settings: updatedSettings});
      });
    });
    return true; // Keep message channel open for async response
  }
  
  if (message.action === "partnerConnected") {
    chrome.storage.local.set({partnerConnected: true}, () => {
      sendResponse({success: true});
    });
    return true; // Keep message channel open for async response
  }
  
  if (message.action === "partnerDisconnected") {
    chrome.storage.local.set({partnerConnected: false}, () => {
      sendResponse({success: true});
    });
    return true; // Keep message channel open for async response
  }
  
  // For actions that don't need an async response, use this pattern:
  if (message.action === "ping") {
    sendResponse({success: true, time: new Date().toISOString()});
    return false; // Don't keep the channel open
  }
});

// Helper functions
function generateRoomCode() {
  // Generate a random 6-character alphanumeric code
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function isStreamingService(url) {
  if (!url) return false;
  
  const supportedServices = [
    "netflix.com",
    "youtube.com",
    "hulu.com",
    "disneyplus.com",
    "hbomax.com",
    "amazon.com"
  ];
  
  return supportedServices.some(service => url.includes(service));
}