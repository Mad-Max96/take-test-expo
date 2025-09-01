import React, { useState, useEffect, useRef } from 'react';
import { SafeAreaView, View, Text, TouchableOpacity, TextInput, Alert, ScrollView, FlatList, AppState, StyleSheet } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseQuestions } from './src/parseQuestions';
import { v4 as uuidv4 } from 'uuid';

export default function App() {
  const [rawText, setRawText] = useState('');
  const [questions, setQuestions] = useState([]);
  const [mode, setMode] = useState('mcq');
  const [testId, setTestId] = useState(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [responses, setResponses] = useState({});
  const [timeLimitSec, setTimeLimitSec] = useState(60 * 60); // default 60 mins
  const [remaining, setRemaining] = useState(0);
  const [startedAt, setStartedAt] = useState(null);
  const timerRef = useRef(null);
  const appState = useRef(AppState.currentState);

  useEffect(() => {
    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  }, [currentIndex, responses, testId]);

  useEffect(() => {
    if (remaining <= 0) {
      if (testId) handleSubmit();
      return;
    }
    // start countdown
    timerRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) {
          clearInterval(timerRef.current);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [remaining, testId]);

  function handleAppStateChange(next) {
    if (!testId) return;
    if (appState.current.match(/active/) && next.match(/inactive|background/)) {
      // app going background: pause current question timer
      pauseCurrentQuestion();
      clearInterval(timerRef.current);
    } else if (appState.current.match(/inactive|background/) && next === 'active') {
      // resume timers
      startQuestionTimer(questions[currentIndex].id);
      // restart countdown (remaining already holds current value)
      timerRef.current = setInterval(() => {
        setRemaining(r => {
          if (r <= 1) {
            clearInterval(timerRef.current);
            return 0;
          }
          return r - 1;
        });
      }, 1000);
    }
    appState.current = next;
  }

  // --- PDF pick fallback: we ask user to paste text into the box (clean PDFs) ---
  async function pickPDF() {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf' });
      if (res.type === 'success') {
        Alert.alert(
          'Paste PDF text',
          'Automatic extraction on Android can be unreliable. Please open the PDF, select the text, copy it, then paste into the text box below and tap Parse.',
        );
        setRawText('');
      }
    } catch (err) {
      Alert.alert('Error', 'Could not open file picker. Please paste PDF text manually.');
      setRawText('');
    }
  }

  function doParse() {
    try {
      const qs = parseQuestions(rawText || '');
      if (!qs || qs.length === 0) {
        Alert.alert('Parsing', 'No questions detected. Ensure text has numbered questions (e.g., "1. ...") and options like "A. ...".');
        return;
      }
      setQuestions(qs);
      Alert.alert('Parsing', `Detected ${qs.length} questions. Review below then Create Test.`);
    } catch (err) {
      Alert.alert('Parse error', err.message || String(err));
    }
  }

  async function createTest() {
    if (!questions || questions.length === 0) {
      Alert.alert('No questions', 'Parse questions first.');
      return;
    }
    const id = uuidv4();
    const test = { id, title: 'Imported Test', mode, time_limit_sec: timeLimitSec, questions };
    await AsyncStorage.setItem('@test_' + id, JSON.stringify(test));
    // add to test list
    const listRaw = await AsyncStorage.getItem('@tests_list');
    const list = listRaw ? JSON.parse(listRaw) : [];
    list.push({ id, title: test.title, created_at: new Date().toISOString() });
    await AsyncStorage.setItem('@tests_list', JSON.stringify(list));

    setTestId(id);
    setStartedAt(Date.now());
    setRemaining(timeLimitSec);
    // initialize responses and start timer for first question
    const firstQid = questions[0].id;
    const respInit = {};
    questions.forEach(q => { respInit[q.id] = { totalTimeMs: 0 }; });
    respInit[firstQid].lastStart = Date.now();
    setResponses(respInit);
    Alert.alert('Test created', 'Test saved locally and ready to attempt.');
  }

  function startQuestionTimer(qId) {
    setResponses(prev => {
      const current = { ...(prev[qId] || { totalTimeMs: 0 }) };
      if (!current.lastStart) current.lastStart = Date.now();
      return { ...prev, [qId]: current };
    });
  }

  function pauseCurrentQuestion() {
    const q = questions[currentIndex];
    if (!q) return;
    const qId = q.id;
    setResponses(prev => {
      const cur = { ...(prev[qId] || { totalTimeMs: 0 }) };
      if (cur.lastStart) {
        cur.totalTimeMs = (cur.totalTimeMs || 0) + (Date.now() - cur.lastStart);
        delete cur.lastStart;
      }
      return { ...prev, [qId]: cur };
    });
  }

  function goto(index) {
    if (index < 0 || index >= questions.length) return;
    pauseCurrentQuestion();
    setCurrentIndex(index);
    // start timer for new question
    const qId = questions[index].id;
    setResponses(prev => {
      const cur = { ...(prev[qId] || { totalTimeMs: 0 }) };
      cur.lastStart = Date.now();
      return { ...prev, [qId]: cur };
    });
  }

  function selectOption(qId, opt) {
    setResponses(prev => {
      const cur = { ...(prev[qId] || { totalTimeMs: 0, lastStart: Date.now() }) };
      cur.selected = opt;
      return { ...prev, [qId]: cur };
    });
  }

  function handleNext() { if (currentIndex < questions.length - 1) goto(currentIndex + 1); }
  function handlePrev() { if (currentIndex > 0) goto(currentIndex - 1); }

  async function handleSubmit() {
    if (!testId) return;
    pauseCurrentQuestion();
    // finalize responses: ensure lastStart removed and totalTimeMs updated
    const finalResponses = { ...responses };
    Object.keys(finalResponses).forEach(k => {
      if (finalResponses[k].lastStart) {
        finalResponses[k].totalTimeMs = (finalResponses[k].totalTimeMs || 0) + (Date.now() - finalResponses[k].lastStart);
        delete finalResponses[k].lastStart;
      }
    });
    const attempt = { id: uuidv4(), test_id: testId, responses: finalResponses, started_at: startedAt, ended_at: Date.now() };
    await AsyncStorage.setItem('@attempt_' + attempt.id, JSON.stringify(attempt));
    // create export file
    const testObjRaw = await AsyncStorage.getItem('@test_' + testId);
    const bundle = { test: JSON.parse(testObjRaw), attempt };
    const fileUri = FileSystem.documentDirectory + 'attempt_' + attempt.id + '.json';
    await FileSystem.writeAsStringAsync(fileUri, JSON.stringify(bundle, null, 2), { encoding: FileSystem.EncodingType.UTF8 });
    Alert.alert('Saved', `Attempt saved locally.\nFile: ${fileUri}`);
    // reset state
    setTestId(null);
    setQuestions([]);
    setRawText('');
    setResponses({});
    setCurrentIndex(0);
    setRemaining(0);
    setStartedAt(null);
  }

  // ----- UI -----
  if (!testId) {
    return (
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={{ padding: 14 }}>
          <Text style={styles.title}>Take Test — Upload & Create</Text>

          <TouchableOpacity onPress={pickPDF} style={styles.buttonPrimary}><Text style={styles.buttonText}>Upload PDF (or use Paste)</Text></TouchableOpacity>

          <Text style={{ marginTop: 12, fontWeight: '600' }}>Paste PDF text here (required):</Text>
          <TextInput value={rawText} onChangeText={setRawText} multiline placeholder="Open PDF, select all text, copy → paste here" style={styles.textArea} />

          <View style={{ flexDirection: 'row', marginTop: 10 }}>
            <TouchableOpacity onPress={doParse} style={[styles.buttonPrimary, { marginRight: 8 }]}><Text style={styles.buttonText}>Parse</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => { setRawText(''); setQuestions([]); }} style={styles.buttonSecondary}><Text>Clear</Text></TouchableOpacity>
          </View>

          <View style={{ marginTop: 14 }}>
            <Text style={{ fontWeight: '600' }}>Mode:</Text>
            <View style={{ flexDirection: 'row', marginTop: 8 }}>
              <TouchableOpacity onPress={() => setMode('mcq')} style={[styles.smallBtn, mode === 'mcq' ? styles.btnActive : null]}><Text style={mode === 'mcq' ? styles.buttonText : null}>MCQ</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => setMode('normal')} style={[styles.smallBtn, mode === 'normal' ? styles.btnActive : null]}><Text style={mode === 'normal' ? styles.buttonText : null}>Normal</Text></TouchableOpacity>
            </View>
            <View style={{ marginTop: 10 }}>
              <Text>Time limit (minutes):</Text>
              <TextInput keyboardType='numeric' value={String(Math.floor(timeLimitSec / 60))} onChangeText={t => setTimeLimitSec(Number(t || 0) * 60)} style={styles.inputSmall} />
            </View>
          </View>

          <TouchableOpacity onPress={createTest} style={[styles.buttonPrimary, { marginTop: 16 }]}><Text style={styles.buttonText}>Create Test</Text></TouchableOpacity>

          <View style={{ marginTop: 20 }}>
            <Text style={{ fontWeight: '700' }}>Preview parsed questions:</Text>
            {questions.map((q, i) => (
              <View key={i} style={styles.qcard}>
                <Text style={{ fontWeight: '600' }}>{q.number}. {q.text}</Text>
                {q.type === 'mcq' && Object.entries(q.options).map(([k, v]) => <Text key={k}>{k}. {v}</Text>)}
              </View>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Test runner UI
  const q = questions[currentIndex];

  return (
    <SafeAreaView style={styles.screen}>
      <View style={{ padding: 12 }}>
        <View style={styles.topbar}>
          <Text>Time left: {Math.floor(remaining / 60)}:{('0' + (remaining % 60)).slice(-2)}</Text>
          <Text>Q {currentIndex + 1} / {questions.length}</Text>
          <TouchableOpacity onPress={handleSubmit} style={styles.btnDanger}><Text style={{ color: 'white' }}>Submit</Text></TouchableOpacity>
        </View>

        <ScrollView style={{ marginTop: 12, backgroundColor: '#fff', padding: 12, borderRadius: 8 }}>
          <Text style={{ fontSize: 18, fontWeight: '600' }}>{q.number}. {q.text}</Text>
          {q.type === 'mcq' && Object.entries(q.options).map(([k, v]) => (
            <TouchableOpacity key={k} onPress={() => selectOption(q.id, k)} style={[styles.option, responses[q.id]?.selected === k ? styles.optionSel : null]}>
              <Text><Text style={{ fontWeight: '700' }}>{k}. </Text>{v}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}>
          <TouchableOpacity onPress={handlePrev} style={styles.buttonSecondary}><Text>Prev</Text></TouchableOpacity>
          <TouchableOpacity onPress={handleNext} style={styles.buttonPrimary}><Text style={styles.buttonText}>Next</Text></TouchableOpacity>
        </View>

        <View style={{ marginTop: 12 }}>
          <Text style={{ fontWeight: '700' }}>Question Palette</Text>
          <FlatList data={questions} numColumns={8} keyExtractor={item => item.id} renderItem={({ item, index }) => (
            <TouchableOpacity onPress={() => goto(index)} style={[styles.pal, responses[item.id]?.selected ? styles.palAnswered : styles.palUnanswered]}>
              <Text>{index + 1}</Text>
            </TouchableOpacity>
          )} />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f3f6fb' },
  title: { fontSize: 22, fontWeight: '700' },
  buttonPrimary: { backgroundColor: '#0b67ff', padding: 12, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: 'white', fontWeight: '700' },
  buttonSecondary: { backgroundColor: '#ddd', padding: 12, borderRadius: 8, alignItems: 'center' },
  smallBtn: { padding: 8, borderRadius: 6, marginRight: 8, backgroundColor: '#eee' },
  btnActive: { backgroundColor: '#0b67ff' },
  inputSmall: { backgroundColor: 'white', padding: 8, borderRadius: 6, marginTop: 6, width: 120 },
  textArea: { minHeight: 120, backgroundColor: 'white', padding: 8, borderRadius: 6, marginTop: 8 },
  qcard: { backgroundColor: 'white', padding: 8, borderRadius: 6, marginTop: 8 },
  topbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  btnDanger: { backgroundColor: '#ff4d4f', padding: 8, borderRadius: 6 },
  option: { padding: 10, borderRadius: 6, borderWidth: 1, borderColor: '#eee', marginTop: 8 },
  optionSel: { borderColor: '#0b67ff', backgroundColor: '#e6f0ff' },
  pal: { width: 38, height: 38, margin: 4, justifyContent: 'center', alignItems: 'center', borderRadius: 6 },
  palAnswered: { backgroundColor: '#6ee7b7' },
  palUnanswered: { backgroundColor: '#ddd' }
});
