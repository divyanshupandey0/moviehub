/**
 * DownloadSheet — Nuvio Plugin Download Server Selector.
 *
 * Dynamically populates download sources exclusively from currently installed
 * & enabled Nuvio plugins supporting the target media type ("movie" | "tv").
 */

import React, { useEffect, useMemo, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  ScrollView,
  Dimensions,
  Animated,
  PanResponder,
  Easing,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { colors } from "../theme/colors";
import { useNuvioPlugins, ALL_NUVIO_PLUGINS_ID } from "../lib/nuvio";

interface DownloadSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  tmdbId: string;
  mediaType: "movie" | "tv";
  season?: number;
  episode?: number;
  onSelectServer: (pluginKeyOrAll: string) => void;
  onManagePlugins?: () => void;
}

const SHEET_TRAVEL = 320;
const SWIPE_DISMISS_THRESHOLD = 0.25;
const RUBBER_BAND_RESISTANCE = 0.3;

export function DownloadSheet({
  visible,
  onClose,
  title,
  mediaType,
  season,
  episode,
  onSelectServer,
  onManagePlugins,
}: DownloadSheetProps) {
  const insets = useSafeAreaInsets();
  const { height: SCREEN_HEIGHT } = Dimensions.get("window");
  const { getEnabledPlugins } = useNuvioPlugins();

  const translateY = useRef(new Animated.Value(SHEET_TRAVEL)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const isVisibleRef = useRef(visible);

  const serverOptions = useMemo(() => {
    const enabled = getEnabledPlugins(mediaType);
    if (enabled.length === 0) return [];
    return [
      {
        key: ALL_NUVIO_PLUGINS_ID,
        label: "All Enabled Plugins",
        desc: `Search ${enabled.length} Nuvio plugin${enabled.length > 1 ? "s" : ""} for direct files`,
        badge: "Recommended",
        highlight: true,
      },
      ...enabled.map((p) => ({
        key: p.pluginKey,
        label: p.name,
        desc:
          [
            p.formats.length > 0 ? p.formats.join("/").toUpperCase() : "Direct",
            p.contentLanguage.join(", ").toUpperCase(),
          ]
            .filter(Boolean)
            .join(" · ") || `v${p.version}`,
        badge: `v${p.version}`,
        highlight: false,
      })),
    ];
  }, [getEnabledPlugins, mediaType]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: () => true,
      onMoveShouldSetPanResponderCapture: () => true,
      onPanResponderMove: (
        _: GestureResponderEvent,
        g: PanResponderGestureState,
      ) => {
        if (g.dy <= 0) return;
        const resisted =
          g.dy <= 80 ? g.dy : 80 + (g.dy - 80) * RUBBER_BAND_RESISTANCE;
        translateY.setValue(resisted);
      },
      onPanResponderRelease: (
        _: GestureResponderEvent,
        g: PanResponderGestureState,
      ) => {
        if (g.dy <= 0) {
          Animated.timing(translateY, {
            toValue: 0,
            duration: 120,
            useNativeDriver: true,
          }).start();
          return;
        }
        if (g.dy > SHEET_TRAVEL * SWIPE_DISMISS_THRESHOLD || g.vy > 0.4) {
          Animated.timing(translateY, {
            toValue: SHEET_TRAVEL,
            duration: 120,
            useNativeDriver: true,
          }).start(() => onClose());
        } else {
          Animated.timing(translateY, {
            toValue: 0,
            duration: 120,
            useNativeDriver: true,
          }).start();
        }
      },
    }),
  ).current;

  useEffect(() => {
    if (visible && !isVisibleRef.current) {
      isVisibleRef.current = true;
      translateY.setValue(SHEET_TRAVEL);
      backdropOpacity.setValue(0);
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: 0,
          duration: 160,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 140,
          useNativeDriver: true,
        }),
      ]).start();
    } else if (!visible && isVisibleRef.current) {
      isVisibleRef.current = false;
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: SHEET_TRAVEL,
          duration: 120,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(backdropOpacity, {
          toValue: 0,
          duration: 120,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, translateY, backdropOpacity]);

  const handleSelect = (key: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onClose();
    setTimeout(() => {
      onSelectServer(key);
    }, 60);
  };

  return (
    <Modal visible={visible} transparent onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Animated.View
          className="absolute inset-0 bg-black/60"
          style={{ opacity: backdropOpacity }}
        >
          <TouchableOpacity
            className="flex-1"
            activeOpacity={1}
            onPress={onClose}
          />
        </Animated.View>

        <Animated.View
          className="border-t"
          style={{
            backgroundColor: colors.bgSurface,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            borderColor: colors.borderSubtle,
            maxHeight: SCREEN_HEIGHT * 0.55,
            paddingBottom: Math.max(insets.bottom, 20),
            transform: [{ translateY }],
          }}
        >
          <View
            {...panResponder.panHandlers}
            className="items-center pt-2.5 pb-2"
          >
            <View
              className="w-10 h-1 rounded-full"
              style={{ backgroundColor: colors.borderMuted }}
            />
          </View>

          <View
            className="flex-row items-center justify-between px-5 pb-3 border-b"
            style={{ borderColor: colors.borderSubtle }}
          >
            <View className="flex-1 mr-3">
              <Text
                className="text-base font-bold"
                style={{
                  color: colors.textPrimary,
                  fontFamily: "Inter_600SemiBold",
                }}
              >
                Download via Nuvio Plugins
              </Text>
              <Text
                className="text-[11px] mt-0.5"
                style={{ color: colors.textTertiary }}
                numberOfLines={1}
              >
                {title}
                {season != null && episode != null
                  ? ` · S${season} E${episode}`
                  : ""}
              </Text>
            </View>

            <TouchableOpacity
              onPress={onClose}
              activeOpacity={0.7}
              className="w-7 h-7 rounded-full items-center justify-center border"
              style={{
                backgroundColor: colors.bgSurface,
                borderColor: colors.borderSubtle,
              }}
            >
              <Ionicons name="close" size={15} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <ScrollView
            className="px-4 pt-3"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 8 }}
          >
            {serverOptions.length === 0 ? (
              <View className="items-center py-6 px-4">
                <Ionicons
                  name="extension-puzzle-outline"
                  size={28}
                  color={colors.textTertiary}
                />
                <Text
                  className="text-sm font-semibold mt-2.5 text-center"
                  style={{ color: colors.textPrimary }}
                >
                  No Nuvio Plugins Enabled
                </Text>
                <Text
                  className="text-xs mt-1 text-center leading-5"
                  style={{ color: colors.textSecondary }}
                >
                  Enable a Nuvio plugin repository in Settings → Nuvio Plugins
                  to discover downloadable files.
                </Text>
                {onManagePlugins && (
                  <TouchableOpacity
                    onPress={() => {
                      onClose();
                      setTimeout(onManagePlugins, 80);
                    }}
                    className="mt-4 rounded-xl py-2.5 px-5"
                    style={{ backgroundColor: colors.gold }}
                    activeOpacity={0.85}
                  >
                    <Text
                      className="text-xs font-bold"
                      style={{ color: colors.bg }}
                    >
                      Open Plugins Manager
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : (
              serverOptions.map((server) => (
                <TouchableOpacity
                  key={server.key}
                  onPress={() => handleSelect(server.key)}
                  activeOpacity={0.7}
                  className="flex-row items-center justify-between px-4 py-3.5 rounded-xl mb-2 border"
                  style={{
                    backgroundColor: colors.bgElevated,
                    borderColor: colors.borderSubtle,
                  }}
                >
                  <View className="flex-row items-center flex-1 mr-3">
                    <View
                      className="w-8 h-8 rounded-full items-center justify-center mr-3"
                      style={{
                        backgroundColor: server.highlight
                          ? colors.goldBadge
                          : "rgba(255, 255, 255, 0.05)",
                      }}
                    >
                      <Ionicons
                        name="cloud-download-outline"
                        size={16}
                        color={
                          server.highlight ? colors.gold : colors.textSecondary
                        }
                      />
                    </View>
                    <View className="flex-1">
                      <Text
                        className="text-sm font-semibold"
                        style={{
                          color: colors.textPrimary,
                          fontFamily: "Inter_500Medium",
                        }}
                      >
                        {server.label}
                      </Text>
                      <Text
                        className="text-[11px] mt-0.5"
                        style={{ color: colors.textTertiary }}
                      >
                        {server.desc}
                      </Text>
                    </View>
                  </View>
                  <View
                    className="px-2 py-0.5 rounded"
                    style={{
                      backgroundColor: server.highlight
                        ? colors.goldBadge
                        : "rgba(255, 255, 255, 0.06)",
                    }}
                  >
                    <Text
                      className="text-[9px] font-bold"
                      style={{
                        color: server.highlight
                          ? colors.gold
                          : colors.textTertiary,
                      }}
                    >
                      {server.badge}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))
            )}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}
