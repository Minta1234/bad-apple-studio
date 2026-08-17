#pragma once
#include <Arduino.h>
#include <SPIFFS.h>
#include <NimBLEDevice.h>
#include <cstdlib>

#define SERVICE_UUID          "12345678-1234-5678-1234-56789abcdef0"
#define CHARACTERISTIC_UUID   "12345678-1234-5678-1234-56789abcdef1"
#define STATUS_CHARACTERISTIC_UUID "12345678-1234-5678-1234-56789abcdef2"

extern File     videoFile;
extern bool     isReceivingVideo;
extern uint32_t expectedUploadBytes;
extern uint32_t receivedUploadBytes;
extern void     reloadVideo();
extern bool     beginVideoReceive(uint32_t expectedBytes);
extern void     endVideoReceive(bool aborted);
extern bool     uploadTargetIsSD();

static NimBLECharacteristic* pStatusChar = nullptr;

// Push a short status code to the web app over the NOTIFY characteristic.
// The write characteristic is WRITE-only (fire-and-forget from the browser's
// side), so this is the only channel the board has to report back which
// storage it picked, or that the transfer needs to be retried/aborted.
static void notifyStatus(const char* msg) {
  if (!pStatusChar) return;
  pStatusChar->setValue((const uint8_t*)msg, strlen(msg));
  pStatusChar->notify();
}

class ServerCallbacks: public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer) override {
        Serial.println("BLE Client Connected");
    }
    void onDisconnect(NimBLEServer* pServer) override {
        Serial.println("BLE Client Disconnected");
        if (isReceivingVideo) {
            // Client dropped mid-transfer — discard the partial file rather than
            // leaving a truncated video.dat that would corrupt playback, and
            // rather than leaving the File handle open across the next mount.
            Serial.println("BLE: disconnected mid-transfer — discarding partial file");
            endVideoReceive(true);
        }
        NimBLEDevice::startAdvertising();
    }
};

class CharacteristicCallbacks: public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pCharacteristic) override {
        std::string rxValue = pCharacteristic->getValue();
        if (rxValue.empty()) return;

        if (rxValue.rfind("START:", 0) == 0) {
            // Protocol: "START:<expectedByteCount>" — the board must know the
            // size up front to decide SPIFFS vs SD *before* any data arrives,
            // instead of failing partway through a write.
            uint32_t expectedBytes = (uint32_t)strtoul(rxValue.c_str() + 6, nullptr, 10);
            if (expectedBytes == 0) {
                Serial.println("BLE: START with invalid/zero size");
                notifyStatus("ERROR:BAD_SIZE");
                return;
            }
            if (beginVideoReceive(expectedBytes)) {
                Serial.printf("BLE: Started receiving video (%u bytes, target=%s)\n",
                              expectedBytes, uploadTargetIsSD() ? "SD" : "SPIFFS");
                notifyStatus(uploadTargetIsSD() ? "OK:SD" : "OK:SPIFFS");
            } else {
                Serial.println("BLE: Not enough free storage for this upload");
                notifyStatus("ERROR:NO_SPACE");
            }

        } else if (rxValue == "END") {
            bool complete = (receivedUploadBytes == expectedUploadBytes);
            endVideoReceive(!complete);
            if (complete) {
                Serial.println("BLE: Finished receiving video");
                notifyStatus("OK:DONE");
            } else {
                Serial.printf("BLE: Size mismatch — got %u of %u bytes\n",
                              receivedUploadBytes, expectedUploadBytes);
                notifyStatus("ERROR:SIZE_MISMATCH");
            }

        } else {
            if (isReceivingVideo && videoFile) {
                size_t written = videoFile.write((const uint8_t*)rxValue.data(), rxValue.length());
                receivedUploadBytes += written;
                if (written != rxValue.length()) {
                    // Storage went away or filled up mid-transfer (e.g. SD card
                    // pulled, or our pre-check was racing another writer).
                    Serial.println("BLE: write failed mid-transfer — aborting");
                    endVideoReceive(true);
                    notifyStatus("ERROR:WRITE_FAIL");
                }
            }
        }
    }
};

void setupBLE() {
    NimBLEDevice::init("BadApple_Studio");
    // Increase MTU to max for faster transfers
    NimBLEDevice::setMTU(512);

    NimBLEServer* pServer = NimBLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());

    NimBLEService* pService = pServer->createService(SERVICE_UUID);

    NimBLECharacteristic* pCharacteristic = pService->createCharacteristic(
                                         CHARACTERISTIC_UUID,
                                         NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
                                       );
    pCharacteristic->setCallbacks(new CharacteristicCallbacks());

    pStatusChar = pService->createCharacteristic(
                                         STATUS_CHARACTERISTIC_UUID,
                                         NIMBLE_PROPERTY::NOTIFY
                                       );

    pService->start();

    NimBLEAdvertising* pAdvertising = NimBLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(true);
    pAdvertising->start();
    Serial.println("BLE Server started. Waiting for connections...");
}