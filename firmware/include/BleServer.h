#pragma once
#include <Arduino.h>
#include <SPIFFS.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
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

static BLECharacteristic* pStatusChar = nullptr;

// Push a short status code to the web app over the NOTIFY characteristic.
static void notifyStatus(const char* msg) {
  if (!pStatusChar) return;
  pStatusChar->setValue((uint8_t*)msg, strlen(msg));
  pStatusChar->notify();
}

class ServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) override {
        Serial.println("BLE Client Connected");
    }
    void onDisconnect(BLEServer* pServer) override {
        Serial.println("BLE Client Disconnected");
        if (isReceivingVideo) {
            Serial.println("BLE: disconnected mid-transfer — discarding partial file");
            endVideoReceive(true);
        }
        // Delay before restarting advertising to allow the ESP32 BLE stack to fully clean up
        // the previous connection. Without this, startAdvertising() can fail silently.
        delay(500);
        pServer->startAdvertising();
    }
};

class CharacteristicCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic* pCharacteristic) override {
        std::string rxValue = pCharacteristic->getValue();
        if (rxValue.empty()) return;

        if (rxValue.rfind("START:", 0) == 0) {
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
                    Serial.println("BLE: write failed mid-transfer — aborting");
                    endVideoReceive(true);
                    notifyStatus("ERROR:WRITE_FAIL");
                }
            }
        }
    }
};

void setupBLE() {
    BLEDevice::init("BadApple_Studio");
    BLEDevice::setMTU(512);

    BLEServer* pServer = BLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());

    BLEService* pService = pServer->createService(SERVICE_UUID);

    BLECharacteristic* pCharacteristic = pService->createCharacteristic(
                                         CHARACTERISTIC_UUID,
                                         BLECharacteristic::PROPERTY_WRITE |
                                         BLECharacteristic::PROPERTY_WRITE_NR
                                       );
    pCharacteristic->setCallbacks(new CharacteristicCallbacks());

    pStatusChar = pService->createCharacteristic(
                                         STATUS_CHARACTERISTIC_UUID,
                                         BLECharacteristic::PROPERTY_NOTIFY
                                       );
    // NOTIFY requires a BLE2902 descriptor for the client to subscribe
    pStatusChar->addDescriptor(new BLE2902());

    pService->start();

    BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->setScanResponse(true);
    // Helps with iPhone/iOS connections
    pAdvertising->setMinPreferred(0x06);
    pAdvertising->setMinPreferred(0x12);
    BLEDevice::startAdvertising();
    Serial.println("BLE Server started. Waiting for connections...");
}