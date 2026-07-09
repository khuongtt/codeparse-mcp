package com.example

import java.util.List

/**
 * Sample Xtend class for parser regression testing.
 * Covers: if/else, for, while, template IF, ternary, compound conditions, method calls.
 */
class SampleXtend {

    def String classify(int value) {
        if (value > 0) "positive"
        else if (value == 0) "zero"
        else "negative"
    }

    def int sumEven(List<Integer> items) {
        var total = 0
        for (i : items) {
            if (i % 2 == 0) total = total + i
        }
        total
    }

    def boolean isInRange(int x, int min, int max) {
        return (x >= min && x <= max) ? true : false
    }

    def String grade(int score) {
        if (score >= 90 && score <= 100) "A"
        else if (score >= 80 && score < 90) "B"
        else if (score >= 70 && score < 80) "C"
        else if (score >= 60 && score < 70) "D"
        else "F"
    }

    def String formatLabel(String name, int count) {
        val label = name.toUpperCase()
        «IF count > 0»
        «label»: [«count»]
        «ELSEIF count == 0»
        «label»: [empty]
        «ELSE»
        «label»: [invalid]
        «ENDIF»
        label
    }

    def int sign(int x) {
        return (x > 0) ? 1 : (x < 0) ? -1 : 0
    }

    def void process(String input) {
        doSomething(input)
    }

    def void doSomething(String input) {
        println(input)
    }
}
