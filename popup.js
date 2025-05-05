// Enhanced popup.js with better room handling
document.addEventListener('DOMContentLoaded', function() {
  console.log('Netflix Together popup loaded');
  
  // Check if a session is active
  checkSessionState();
  
  // Set up button click handlers
  document.getElementById('create-session').addEventListener('click', createSession);
  document.getElementById('join-session').addEventListener('click', joinSession);
  document.getElementById('copy-code').addEventListener('click', copyRoomCode);
  document.getElementById('end-session').addEventListener('click', endSession);
  
  // Input validation - ensures proper formatting of room codes
  document.getElementById('room-code-input').addEventListener('input', function(e) {
    // Convert to uppercase
    this.value = this.value.toUpperCase();
    // Remove non-alphanumeric characters
    this.value = this.value.replace(/[^A-Z0-9]/g, '');
    // Limit to 6 characters
    if (this.value.length > 6) {
      this.value = this.value.slice(0, 6);
    }
  });
  
  // Handle room code entry on Enter key press
  document.getElementById('room-code-input').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      joinSession();
    }
  });
});

function checkSessionState() {
  chrome.storage.local.get(['sessionActive', 'roomCode', 'partnerConnected'], function(data) {
    console.log('Session state:', data);
    
    if (data.sessionActive) {
      // Show active session UI
      document.getElementById('active-session').style.display = 'block';
      document.getElementById('no-active-session').style.display = 'none';
      
      // Set room code
      const roomCodeElement = document.getElementById('current-room-code');
      roomCodeElement.textContent = data.roomCode;
      
      // Make room code more visible
      roomCodeElement.style.fontSize = '28px';
      roomCodeElement.style.letterSpacing = '3px';
      
      // Update partner status
      const partnerStatus = document.getElementById('partner-status');
      if (data.partnerConnected) {
        partnerStatus.className = 'status online';
        partnerStatus.innerHTML = '<i class="fas fa-circle"></i><span>Partner connected</span>';
      } else {
        partnerStatus.className = 'status offline';
        partnerStatus.innerHTML = '<i class="fas fa-circle"></i><span>Waiting for partner</span>';
      }
    } else {
      // Show inactive session UI
      document.getElementById('active-session').style.display = 'none';
      document.getElementById('no-active-session').style.display = 'block';
    }
  });
}

function createSession() {
  console.log('Creating new session...');
  
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    const currentTab = tabs[0];
    
    if (!isStreamingService(currentTab.url)) {
      alert('Please navigate to a supported streaming service (Netflix, YouTube, Hulu, Disney+, HBO Max, or Amazon Prime Video).');
      return;
    }
    
    // Generate a room code
    const roomCode = generateRoomCode();
    console.log('Generated room code:', roomCode);
    
    chrome.runtime.sendMessage({
      action: 'startSession',
      roomCode: roomCode
    }, function(response) {
      if (response && response.success) {
        console.log('Session created successfully with room code:', response.roomCode);
        
        // Show notification
        const notification = document.createElement('div');
        notification.innerHTML = `<div style="position:fixed;top:0;left:0;right:0;background:#4CAF50;color:white;padding:10px;text-align:center;z-index:9999;">
          Session created! Room code: <strong>${response.roomCode}</strong>
        </div>`;
        document.body.appendChild(notification);
        
        // Remove notification after 3 seconds
        setTimeout(() => {
          notification.remove();
        }, 3000);
        
        // Update UI
        checkSessionState();
      } else {
        console.error('Failed to create session:', response);
        alert('Failed to create session. ' + (response ? response.message : 'Please try again.'));
      }
    });
  });
}

function joinSession() {
  const roomCodeInput = document.getElementById('room-code-input');
  let roomCode = roomCodeInput.value.trim();
  
  // Normalize room code (uppercase, remove spaces)
  roomCode = roomCode.toUpperCase().replace(/\s/g, '');
  
  console.log('Attempting to join room:', roomCode);
  
  if (roomCode.length !== 6) {
    alert('Please enter a valid 6-character room code.');
    return;
  }
  
  chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    const currentTab = tabs[0];
    
    if (!isStreamingService(currentTab.url)) {
      alert('Please navigate to a supported streaming service (Netflix, YouTube, Hulu, Disney+, HBO Max, or Amazon Prime Video).');
      return;
    }
    
    console.log('Sending joinSession message with room code:', roomCode);
    
    chrome.runtime.sendMessage({
      action: 'joinSession',
      roomCode: roomCode
    }, function(response) {
      if (response && response.success) {
        console.log('Successfully joined session:', roomCode);
        
        // Show notification
        const notification = document.createElement('div');
        notification.innerHTML = `<div style="position:fixed;top:0;left:0;right:0;background:#2196F3;color:white;padding:10px;text-align:center;z-index:9999;">
          Joined session! Room code: <strong>${roomCode}</strong>
        </div>`;
        document.body.appendChild(notification);
        
        // Remove notification after 3 seconds
        setTimeout(() => {
          notification.remove();
        }, 3000);
        
        // Update UI
        checkSessionState();
      } else {
        console.error('Failed to join session:', response);
        alert('Failed to join session. ' + (response ? response.message : 'Please check the room code and try again.'));
      }
    });
  });
}

function copyRoomCode() {
  const roomCode = document.getElementById('current-room-code').textContent;
  
  console.log('Copying room code to clipboard:', roomCode);
  
  navigator.clipboard.writeText(roomCode).then(function() {
    console.log('Room code copied successfully');
    
    const copyButton = document.getElementById('copy-code');
    const originalText = copyButton.innerHTML;
    
    copyButton.innerHTML = '<i class="fas fa-check"></i> Copied!';
    
    setTimeout(function() {
      copyButton.innerHTML = originalText;
    }, 2000);
  }).catch(function(err) {
    console.error('Could not copy text: ', err);
    alert('Failed to copy room code to clipboard.');
  });
}

function endSession() {
  console.log('Ending current session...');
  
  chrome.runtime.sendMessage({
    action: 'endSession'
  }, function(response) {
    if (response && response.success) {
      console.log('Session ended successfully');
      
      // Show notification
      const notification = document.createElement('div');
      notification.innerHTML = `<div style="position:fixed;top:0;left:0;right:0;background:#F44336;color:white;padding:10px;text-align:center;z-index:9999;">
        Session ended
      </div>`;
      document.body.appendChild(notification);
      
      // Remove notification after 3 seconds
      setTimeout(() => {
        notification.remove();
      }, 3000);
      
      // Update UI
      checkSessionState();
    } else {
      console.error('Failed to end session:', response);
      alert('Failed to end session.');
    }
  });
}

function generateRoomCode() {
  // Generate a random 6-character alphanumeric code
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars like O, 0, 1, I
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function isStreamingService(url) {
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

// Listen for storage changes to update UI in real time
chrome.storage.onChanged.addListener(function(changes, namespace) {
  if (namespace === 'local') {
    console.log('Storage changes detected:', changes);
    if (changes.sessionActive || changes.roomCode || changes.partnerConnected) {
      checkSessionState();
    }
  }
});

// Add a refresh function to reload the popup state
window.refreshPopup = function() {
  console.log('Manually refreshing popup state');
  checkSessionState();
};